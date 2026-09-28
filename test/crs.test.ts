import { describe, expect, it } from 'vitest';
import { CrsClient, CrsError, FRAME_LENGTH } from '../src/ble/crs';
import { FakeFlySight, FakeFs, shortName } from '../src/ble/fakeDevice';

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function setup(files: Record<string, Uint8Array>, opts: ConstructorParameters<typeof FakeFlySight>[1] = {}) {
  const fs = new FakeFs();
  for (const [path, data] of Object.entries(files)) fs.addFile(path, data, new Date(Date.UTC(2026, 8, 26, 16, 40, 56)));
  const device = new FakeFlySight(fs, { ackTimeoutMs: 20, ...opts });
  const client = new CrsClient(device, { keepaliveMs: 0, idleTimeoutMs: 2000, drainMs: 50 });
  return { device, client };
}

describe('CRS client', () => {
  it('lists folders without dot entries', async () => {
    const { client } = setup({ '/26-09-26/16-40-55/TRACK.CSV': bytes(10), '/CONFIG.TXT': bytes(3) });
    const root = await client.listDir('/');
    expect(root.map((e) => [e.name, e.isDir, e.size])).toEqual([
      ['26-09-26', true, 0],
      ['CONFIG.TXT', false, 3],
    ]);
    const session = await client.listDir('/26-09-26/16-40-55');
    expect(session).toHaveLength(1);
    expect(session[0]).toMatchObject({ name: 'TRACK.CSV', size: 10, isDir: false, modified: '2026-09-26 16:40:56' });
  });

  it('rejects a missing folder and stays usable', async () => {
    const { client } = setup({ '/A.TXT': bytes(1) });
    await expect(client.listDir('/NOPE')).rejects.toBeInstanceOf(CrsError);
    await expect(client.ping()).resolves.toBeUndefined();
  });

  it.each([0, 1, FRAME_LENGTH - 1, FRAME_LENGTH, FRAME_LENGTH * 3, 5000])('reads a %i byte file', async (n) => {
    const data = bytes(n);
    const { client } = setup({ '/F.BIN': data });
    const progress: number[] = [];
    const got = await client.readFile('/F.BIN', { onProgress: (b) => progress.push(b) });
    expect(got).toEqual(data);
    if (n > 0) expect(progress.at(-1)).toBe(n);
  });

  it('reads past the 8-bit sequence wrap with packet loss', async () => {
    const data = bytes(FRAME_LENGTH * 600 + 17); // > 2 wraps of seq
    const { client } = setup({ '/BIG.BIN': data }, { lossRate: 0.05, seed: 42 });
    expect(await client.readFile('/BIG.BIN')).toEqual(data);
  });

  it('rejects a missing file and stays usable', async () => {
    const { client } = setup({ '/A.TXT': bytes(1) });
    await expect(client.readFile('/MISSING.CSV')).rejects.toThrow(/Cannot open/);
    await expect(client.readFile('/A.TXT')).resolves.toHaveLength(1);
  });

  it('cancels a transfer and the next read is not polluted by stray packets', async () => {
    const big = bytes(FRAME_LENGTH * 200);
    const small = bytes(FRAME_LENGTH * 2 + 5, 99);
    const { client } = setup({ '/BIG.BIN': big, '/SMALL.BIN': small }, { packetIntervalMs: 1 });
    const ac = new AbortController();
    const first = client.readFile('/BIG.BIN', {
      signal: ac.signal,
      onProgress: (b) => b > FRAME_LENGTH * 10 && ac.abort(),
    });
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(await client.readFile('/SMALL.BIN')).toEqual(small);
  });

  it('fails pending operations on disconnect', async () => {
    const { client, device } = setup({ '/BIG.BIN': bytes(FRAME_LENGTH * 200) }, { packetIntervalMs: 1 });
    const p = client.readFile('/BIG.BIN');
    setTimeout(() => device.disconnect(), 20);
    await expect(p).rejects.toThrow(/disconnected/);
    await expect(client.ping()).rejects.toThrow(/Not connected/);
  });
});

describe('shortName', () => {
  it.each([
    ['track.csv', 'TRACK.CSV'],
    ['26-09-26', '26-09-26'],
    ['System Volume Information', 'SYSTEM~1'],
    ['.flysight-serial', 'FLYSIG~1'],
  ])('%s -> %s', (name, short) => expect(shortName(name)).toBe(short));
});
