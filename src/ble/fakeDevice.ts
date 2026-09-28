/**
 * In-memory FlySight that speaks CRS the way flysight-2-firmware
 * FlySight/crs.c does: same states, same window, same resend-on-timeout, and
 * the same habit of ignoring commands other than CANCEL mid-transfer.
 *
 * Used by the tests and by the page's demo mode.
 */
import { ATTR_ARCHIVE, ATTR_DIRECTORY, encodeFatDateTime } from '../fs/fat';
import { Cmd, FRAME_LENGTH } from './crs';
import type { Link } from './link';

const WINDOW_LENGTH = 8;

export interface FakeNode {
  isDir: boolean;
  size: number;
  modified: Date;
  /** File contents, loaded on first read so large folders stay cheap. */
  load?: () => Promise<Uint8Array>;
}

export type FakeContent = Uint8Array | { size: number; load: () => Promise<Uint8Array> };

/**
 * Directory tree served by the simulator. Paths are stored the way FatFs
 * without long file names reports them: upper-case 8.3.
 */
export class FakeFs {
  private readonly nodes = new Map<string, FakeNode>([['/', { isDir: true, size: 0, modified: new Date(0) }]]);

  addFile(path: string, content: FakeContent, modified = new Date()): void {
    const p = normalize(path);
    this.addDir(parent(p), modified);
    const node =
      content instanceof Uint8Array
        ? { size: content.length, load: () => Promise.resolve(content) }
        : content;
    this.nodes.set(p, { isDir: false, modified, ...node });
  }

  addDir(path: string, modified = new Date()): void {
    const p = normalize(path);
    if (this.nodes.has(p)) return;
    if (p !== '/') this.addDir(parent(p), modified);
    this.nodes.set(p, { isDir: true, size: 0, modified });
  }

  get(path: string): FakeNode | undefined {
    return this.nodes.get(normalize(path));
  }

  list(path: string): { name: string; node: FakeNode }[] {
    const dir = normalize(path);
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const out: { name: string; node: FakeNode }[] = [];
    for (const [p, node] of this.nodes) {
      if (p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) {
        out.push({ name: p.slice(prefix.length), node });
      }
    }
    return out;
  }
}

export interface FakeOptions {
  name?: string;
  /** Probability that an outgoing FILE_DATA packet is lost. */
  lossRate?: number;
  /** Firmware resends from the last ack after this long (TX_TIMEOUT_MSEC). */
  ackTimeoutMs?: number;
  /** Delay between outgoing packets, to mimic link throughput. */
  packetIntervalMs?: number;
  seed?: number;
  /** Battery level to report, % (null: not measured yet); none by default, like release firmware. */
  battery?: number | null;
}

interface ReadState {
  data: Uint8Array;
  offset: number;
  stride: number;
  nextPacket: number;
  nextAck: number;
  lastPacket: number;
}

export class FakeFlySight implements Link {
  readonly id: string;
  readonly name: string;
  onPacket: ((data: Uint8Array) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  readonly battery: number | null | undefined;
  onBattery: (() => void) | null = null;

  private read: ReadState | null = null;
  private inbox: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly out: Uint8Array[] = [];
  private sending = false;
  private connected = true;
  private readonly random: () => number;

  private readonly lossRate: number;
  private readonly ackTimeoutMs: number;
  private readonly packetIntervalMs: number;

  constructor(
    readonly fs: FakeFs,
    options: FakeOptions = {},
  ) {
    this.name = options.name ?? 'FlySight (demo)';
    this.id = `fake:${this.name}`;
    this.lossRate = options.lossRate ?? 0;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 200;
    this.packetIntervalMs = options.packetIntervalMs ?? 0;
    this.random = mulberry32(options.seed ?? 1);
    this.battery = options.battery;
  }

  write(data: Uint8Array): Promise<void> {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    const packet = data.slice();
    // Commands are handled one at a time, in order, even when opening a file
    // has to wait for its contents to load.
    this.inbox = this.inbox.then(() => this.receive(packet)).catch(() => {});
    return Promise.resolve();
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.stopRead();
    this.out.length = 0;
    this.onDisconnect?.();
  }

  private async receive(p: Uint8Array): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    if (!this.connected || p.length === 0) return;
    if (this.read) this.receiveWhileReading(p);
    else await this.receiveIdle(p);
  }

  private async receiveIdle(p: Uint8Array): Promise<void> {
    switch (p[0]) {
      case Cmd.READ: {
        const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const node = p.length > 9 ? this.fs.get(cString(p, 9)) : undefined;
        const data = node?.load ? await node.load().catch(() => null) : null;
        if (!data) {
          this.send(Cmd.NAK, Cmd.READ);
          return;
        }
        const offset = view.getUint32(1, true) * FRAME_LENGTH;
        const stride = (view.getUint32(5, true) + 1) * FRAME_LENGTH;
        this.read = { data, offset, stride, nextPacket: 0, nextAck: 0, lastPacket: Infinity };
        this.send(Cmd.ACK, Cmd.READ);
        this.restartTimer();
        this.pump();
        return;
      }
      case Cmd.READ_DIR: {
        const path = cString(p, 1);
        const node = this.fs.get(path);
        if (!node?.isDir) {
          this.send(Cmd.NAK, Cmd.READ_DIR);
          return;
        }
        this.send(Cmd.ACK, Cmd.READ_DIR);
        const entries = this.fs.list(path);
        if (normalize(path) !== '/') {
          entries.unshift({ name: '..', node }, { name: '.', node });
        }
        let seq = 0;
        for (const { name, node: n } of entries) this.sendFileInfo(seq++, name, n);
        this.sendFileInfo(seq, '', null);
        return;
      }
      case Cmd.PING:
        this.send(Cmd.ACK, Cmd.PING);
        return;
      default:
        this.send(Cmd.NAK, p[0]);
    }
  }

  private receiveWhileReading(p: Uint8Array): void {
    const r = this.read!;
    if (p[0] === Cmd.CANCEL) {
      this.stopRead();
      return;
    }
    if (p[0] === Cmd.FILE_ACK && p.length >= 2 && p[1] === (r.nextAck & 0xff)) {
      r.nextAck++;
      this.restartTimer();
      if (r.nextAck === r.lastPacket) {
        this.stopRead();
        return;
      }
      this.pump();
    }
    // Anything else is silently dropped, as in FS_CRS_State_Read.
  }

  private pump(): void {
    const r = this.read;
    if (!r) return;
    while (r.nextPacket < r.nextAck + WINDOW_LENGTH && r.nextPacket < r.lastPacket) {
      const seq = r.nextPacket & 0xff;
      const pos = r.offset + r.nextPacket * r.stride;
      if (pos >= r.data.length) {
        this.sendData(seq, new Uint8Array(0));
        r.lastPacket = ++r.nextPacket;
      } else {
        this.sendData(seq, r.data.subarray(pos, pos + FRAME_LENGTH));
        r.nextPacket++;
      }
    }
  }

  private restartTimer(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const r = this.read;
      if (!r) return;
      r.nextPacket = r.nextAck;
      this.restartTimer();
      this.pump();
    }, this.ackTimeoutMs);
  }

  private stopRead(): void {
    clearTimeout(this.timer);
    this.read = null;
  }

  private sendData(seq: number, data: Uint8Array): void {
    if (this.lossRate > 0 && this.random() < this.lossRate) return;
    const p = new Uint8Array(2 + data.length);
    p[0] = Cmd.FILE_DATA;
    p[1] = seq;
    p.set(data, 2);
    this.enqueue(p);
  }

  private sendFileInfo(seq: number, name: string, node: FakeNode | null): void {
    const p = new Uint8Array(24);
    const view = new DataView(p.buffer);
    p[0] = Cmd.FILE_INFO;
    p[1] = seq & 0xff;
    if (node) {
      const { fdate, ftime } = encodeFatDateTime(node.modified);
      view.setUint32(2, node.isDir ? 0 : node.size, true);
      view.setUint16(6, fdate, true);
      view.setUint16(8, ftime, true);
      p[10] = node.isDir ? ATTR_DIRECTORY : ATTR_ARCHIVE;
      for (let i = 0; i < Math.min(name.length, 12); i++) p[11 + i] = name.charCodeAt(i);
    }
    this.enqueue(p);
  }

  private send(...bytes: number[]): void {
    this.enqueue(Uint8Array.from(bytes));
  }

  private enqueue(p: Uint8Array): void {
    this.out.push(p);
    if (this.sending) return;
    this.sending = true;
    const next = () => {
      const packet = this.out.shift();
      if (!packet || !this.connected) {
        this.sending = false;
        return;
      }
      this.onPacket?.(packet);
      setTimeout(next, this.packetIntervalMs);
    };
    setTimeout(next, this.packetIntervalMs);
  }
}

function normalize(path: string): string {
  const parts = path.split('/').filter(Boolean).map(shortName);
  return `/${parts.join('/')}`;
}

/**
 * Approximate the 8.3 alias FAT gives a long name ("System Volume
 * Information" -> "SYSTEM~1"), since the firmware never sees long names.
 */
export function shortName(name: string): string {
  const upper = name.toUpperCase();
  if (/^[A-Z0-9_$~!#%&'(){}^@`-]{1,8}(\.[A-Z0-9_$~!#%&'(){}^@`-]{1,3})?$/.test(upper)) return upper;
  const dot = upper.lastIndexOf('.');
  const clean = (s: string) => s.replace(/[^A-Z0-9_$~!#%&'(){}^@`-]/g, '');
  const base = clean(dot > 0 ? upper.slice(0, dot) : upper).slice(0, 6) || 'FILE';
  const ext = dot > 0 ? clean(upper.slice(dot + 1)).slice(0, 3) : '';
  return `${base}~1${ext ? `.${ext}` : ''}`;
}

function parent(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

function cString(p: Uint8Array, start: number): string {
  let s = '';
  for (let i = start; i < p.length && p[i] !== 0; i++) s += String.fromCharCode(p[i]);
  return s;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
