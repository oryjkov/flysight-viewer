import { describe, expect, it } from 'vitest';
import { CrsClient } from '../src/ble/crs';
import { FakeFlySight, FakeFs } from '../src/ble/fakeDevice';
import { findNewSessions, newestSession } from '../src/sync';

const data = (n: number) => new Uint8Array(n).fill(65);

function device(paths: string[]): CrsClient {
  const fs = new FakeFs();
  for (const p of paths) fs.addFile(p, data(100));
  return new CrsClient(new FakeFlySight(fs, { ackTimeoutMs: 20 }), { keepaliveMs: 0, idleTimeoutMs: 2000, drainMs: 50 });
}

const CARD = [
  '/CONFIG.TXT',
  '/26-09-25/14-27-26/TRACK.CSV',
  '/26-09-25/14-27-26/SENSOR.CSV',
  '/26-09-26/07-00-53/TRACK.CSV',
  '/26-09-26/08-46-20/TRACK.CSV',
  '/26-09-26/10-29-03/SENSOR.CSV', // no track: skipped
  '/26-09-26/13-34-06/TRACK.CSV',
  '/TEMP/0016/TRACK.CSV',
];

describe('get new jumps', () => {
  it('finds the newest cached session', () => {
    expect(newestSession(['/26-09-25/14-27-26/TRACK.CSV', '/26-09-26/07-00-53/SENSOR.CSV', '/CONFIG.TXT'])).toBe(
      '26-09-26/07-00-53',
    );
    expect(newestSession(['/TEMP/0016/TRACK.CSV'])).toBeNull();
  });

  it('downloads only the most recent day when nothing is cached', async () => {
    const found = await findNewSessions(device(CARD), []);
    expect(found.map((s) => s.path)).toEqual([
      '/26-09-26/07-00-53/TRACK.CSV',
      '/26-09-26/08-46-20/TRACK.CSV',
      '/26-09-26/13-34-06/TRACK.CSV',
    ]);
  });

  it('takes every session after the newest cached one, across days, oldest first', async () => {
    const found = await findNewSessions(device(CARD), ['/26-09-25/14-27-26/SENSOR.CSV']);
    expect(found.map((s) => s.dir)).toEqual(['/26-09-26/07-00-53', '/26-09-26/08-46-20', '/26-09-26/13-34-06']);
    expect(found[0].track.size).toBe(100);
  });

  it('finds nothing when up to date, and skips tracks already cached', async () => {
    expect(await findNewSessions(device(CARD), ['/26-09-26/13-34-06/TRACK.CSV'])).toEqual([]);
    const found = await findNewSessions(device(CARD), ['/26-09-26/07-00-53/TRACK.CSV', '/26-09-26/13-34-06/SENSOR.CSV']);
    expect(found).toEqual([]);
  });
});
