// Serve a real SD card copy through the simulated device and pull files the
// way the page does. Skipped when no card copy is available.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CrsClient } from '../src/ble/crs';
import { FakeFlySight, FakeFs } from '../src/ble/fakeDevice';
import { summarize } from '../src/parse/summary';

const CARD = process.env.FLYSIGHT_DATA ?? join(homedir(), 'flysight/fly2');

function loadCard(root: string): FakeFs {
  const fs = new FakeFs();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        fs.addDir(relative(root, full), st.mtime);
        walk(full);
      } else {
        fs.addFile(relative(root, full), { size: st.size, load: async () => readFileSync(full) }, st.mtime);
      }
    }
  };
  walk(root);
  return fs;
}

describe.skipIf(!existsSync(CARD))(`end to end against ${CARD}`, () => {
  it('browses to the newest session and downloads its track', async () => {
    const client = new CrsClient(new FakeFlySight(loadCard(CARD), { lossRate: 0.01, ackTimeoutMs: 20 }), { keepaliveMs: 0 });

    const root = await client.listDir('/');
    const names = root.map((e) => e.name);
    expect(names).toContain('CONFIG.TXT');
    expect(names).toContain('SYSTEM~1'); // long names appear as 8.3 aliases
    const dates = root.filter((e) => e.isDir && /^\d\d-\d\d-\d\d$/.test(e.name)).map((e) => e.name).sort();
    const date = dates.at(-1)!;

    const sessions = (await client.listDir(`/${date}`)).map((e) => e.name).sort();
    const sessionPath = `/${date}/${sessions.at(-1)}`;
    const files = await client.listDir(sessionPath);
    const track = files.find((e) => e.name === 'TRACK.CSV')!;
    expect(track.size).toBeGreaterThan(0);

    const data = await client.readFile(`${sessionPath}/TRACK.CSV`);
    expect(data.length).toBe(track.size);
    expect(Buffer.from(data).equals(readFileSync(join(CARD, date, sessions.at(-1)!, 'TRACK.CSV')))).toBe(true);
    expect(summarize('TRACK.CSV', data).kind).toBe('GNSS track');

    const config = await client.readFile('/CONFIG.TXT');
    expect(summarize('CONFIG.TXT', config).preview).toMatch(/FlySight/);
    client.close();
  }, 60_000);
});
