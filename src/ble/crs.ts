/**
 * Client for the FlySight 2 CRS file transfer protocol.
 *
 * Mirrors flysight-2-firmware FlySight/crs.c. Every packet is
 * [command][payload]; the device answers commands with ACK/NAK [F1|F0][cmd].
 * File reads stream FILE_DATA [10][seq][data] under a go-back-N window of
 * 8 packets that the client drives with FILE_ACK [12][seq].
 */
import { ATTR_DIRECTORY, formatFatDateTime } from '../fs/fat';
import type { Link } from './link';

export const Cmd = {
  CREATE: 0x00,
  DELETE: 0x01,
  READ: 0x02,
  WRITE: 0x03,
  MK_DIR: 0x04,
  READ_DIR: 0x05,
  FILE_DATA: 0x10,
  FILE_INFO: 0x11,
  FILE_ACK: 0x12,
  NAK: 0xf0,
  ACK: 0xf1,
  PING: 0xfe,
  CANCEL: 0xff,
} as const;

/** Data bytes per FILE_DATA packet (FRAME_LENGTH in crs.c). */
export const FRAME_LENGTH = 242;

export interface DirEntry {
  name: string;
  size: number;
  attr: number;
  isDir: boolean;
  /** "YYYY-MM-DD HH:MM:SS" from the FAT timestamp, or null if unset. */
  modified: string | null;
}

export interface ReadOptions {
  onProgress?: (bytes: number) => void;
  signal?: AbortSignal;
}

export class CrsError extends Error {
  override name = 'CrsError';
}

interface Control<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

export interface CrsClientOptions {
  /** Fail an operation after this long without hearing from the device. */
  idleTimeoutMs?: number;
  /**
   * The firmware drops the connection after 30 s without a write
   * (custom_app.c TIMEOUT_MSEC), so ping while idle.
   */
  keepaliveMs?: number;
  /** Time to let stray packets drain after cancelling an operation. */
  drainMs?: number;
}

export class CrsClient {
  private handler: ((packet: Uint8Array) => void) | null = null;
  private failCurrent: ((error: unknown) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private readonly idleTimeoutMs: number;
  private readonly drainMs: number;

  constructor(
    readonly link: Link,
    options: CrsClientOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5000;
    this.drainMs = options.drainMs ?? 300;
    link.onPacket = (p) => this.handler?.(p);
    link.onDisconnect = () => this.close(new CrsError('FlySight disconnected'));

    const keepaliveMs = options.keepaliveMs ?? 20000;
    if (keepaliveMs > 0) {
      this.keepaliveTimer = setInterval(() => {
        if (this.busy === 0) this.ping().catch(() => {});
      }, keepaliveMs);
    }
  }

  /** Called when the link drops; fails any operation in progress. */
  onClose: ((error: Error) => void) | null = null;

  get isBusy(): boolean {
    return this.busy > 0;
  }

  ping(): Promise<void> {
    return this.run(() =>
      this.transact<void>(Uint8Array.of(Cmd.PING), (p, ctl) => {
        if (isReply(p, Cmd.ACK, Cmd.PING)) ctl.resolve();
      }),
    );
  }

  listDir(path: string): Promise<DirEntry[]> {
    return this.run(async () => {
      const entries: DirEntry[] = [];
      let started = false;
      try {
        return await this.transact<DirEntry[]>(withPath([Cmd.READ_DIR], path), (p, ctl) => {
          if (!started) {
            if (isReply(p, Cmd.ACK, Cmd.READ_DIR)) started = true;
            else if (isReply(p, Cmd.NAK, Cmd.READ_DIR)) ctl.reject(new CrsError(`Cannot open folder ${path}`));
            return;
          }
          if (p[0] !== Cmd.FILE_INFO || p.length < 24) return;
          const entry = parseFileInfo(p);
          if (entry.name === '') ctl.resolve(entries);
          // FatFs returns dot entries in subdirectories when relative paths are enabled
          else if (entry.name !== '.' && entry.name !== '..') entries.push(entry);
        });
      } catch (e) {
        await this.cancelAndDrain();
        throw e;
      }
    });
  }

  readFile(path: string, options: ReadOptions = {}): Promise<Uint8Array> {
    return this.run(async () => {
      options.signal?.throwIfAborted();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let expected = 0;
      let started = false;
      let shortSeen = false;

      const request = withPath([Cmd.READ, ...u32(0), ...u32(0)], path);
      try {
        return await this.transact<Uint8Array>(
          request,
          (p, ctl) => {
            // Stray FILE_DATA from a cancelled read can still be queued on the
            // device; everything before our ACK belongs to someone else.
            if (!started) {
              if (isReply(p, Cmd.ACK, Cmd.READ)) started = true;
              else if (isReply(p, Cmd.NAK, Cmd.READ)) ctl.reject(new CrsError(`Cannot open ${path}`));
              return;
            }
            if (p[0] !== Cmd.FILE_DATA || p.length < 2) return;
            // Out-of-order packets are dropped; the device resends from the
            // first unacknowledged packet after 200 ms.
            if (p[1] !== (expected & 0xff)) return;

            this.sendAck(p[1]);
            expected++;

            const data = p.subarray(2);
            if (data.length === 0) {
              ctl.resolve(concat(chunks, received));
              return;
            }
            if (shortSeen) {
              ctl.reject(
                new CrsError(
                  'Received truncated packets. The BLE MTU is too small for this device (needs ≥ 247).',
                ),
              );
              return;
            }
            if (data.length < FRAME_LENGTH) shortSeen = true;
            chunks.push(data.slice());
            received += data.length;
            options.onProgress?.(received);
          },
          options.signal,
        );
      } catch (e) {
        await this.cancelAndDrain();
        throw e;
      }
    });
  }

  close(error: Error = new CrsError('Closed')): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.failCurrent?.(error);
    this.link.onPacket = null;
    this.link.onDisconnect = null;
    this.onClose?.(error);
  }

  disconnect(): void {
    this.close();
    this.link.disconnect();
  }

  /** Operations are serialized: the device handles one at a time. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(async () => {
      if (this.closed) throw new CrsError('Not connected');
      this.busy++;
      try {
        return await fn();
      } finally {
        this.busy--;
      }
    });
    this.queue = p.catch(() => {});
    return p;
  }

  private transact<T>(
    request: Uint8Array,
    onPacket: (packet: Uint8Array, ctl: Control<T>) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;

      const finish = (fn: () => void) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.handler = null;
        this.failCurrent = null;
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const ctl: Control<T> = {
        resolve: (v) => finish(() => resolve(v)),
        reject: (e) => finish(() => reject(e)),
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => ctl.reject(new CrsError('Timed out waiting for the FlySight')),
          this.idleTimeoutMs,
        );
      };
      const onAbort = () => ctl.reject(new DOMException('Cancelled', 'AbortError'));

      signal?.addEventListener('abort', onAbort);
      this.failCurrent = ctl.reject;
      this.handler = (p) => {
        arm();
        try {
          onPacket(p, ctl);
        } catch (e) {
          ctl.reject(e);
        }
      };
      arm();
      this.link.write(request).catch(ctl.reject);
    });
  }

  private sendAck(seq: number): void {
    this.link.write(Uint8Array.of(Cmd.FILE_ACK, seq)).catch(() => {
      // A lost ack only costs a resend; a dead link is reported via onDisconnect.
    });
  }

  /**
   * Return the device to idle after a failed or cancelled operation.
   *
   * In its read and dir states the firmware ignores every command but CANCEL,
   * and it only re-runs its state machine when a packet arrives, so give it a
   * moment before the next command.
   */
  private async cancelAndDrain(): Promise<void> {
    if (this.closed) return;
    await this.link.write(Uint8Array.of(Cmd.CANCEL)).catch(() => {});
    await new Promise((r) => setTimeout(r, this.drainMs));
  }
}

export function parseFileInfo(p: Uint8Array): DirEntry {
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  // [11][seq][size u32][fdate u16][ftime u16][attr u8][name 13]
  const size = view.getUint32(2, true);
  const fdate = view.getUint16(6, true);
  const ftime = view.getUint16(8, true);
  const attr = p[10];
  let name = '';
  for (let i = 11; i < 24 && p[i] !== 0; i++) name += String.fromCharCode(p[i]);
  return { name, size, attr, isDir: (attr & ATTR_DIRECTORY) !== 0, modified: formatFatDateTime(fdate, ftime) };
}

function isReply(p: Uint8Array, kind: number, cmd: number): boolean {
  return p.length >= 2 && p[0] === kind && p[1] === cmd;
}

/** FAT paths are 8.3 ASCII; the firmware treats them as byte strings. */
function withPath(prefix: number[], path: string): Uint8Array {
  const out = new Uint8Array(prefix.length + path.length + 1);
  out.set(prefix);
  for (let i = 0; i < path.length; i++) out[prefix.length + i] = path.charCodeAt(i) & 0xff;
  return out;
}

function u32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
