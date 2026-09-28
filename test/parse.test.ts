import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFlysightCsv } from '../src/parse/flysight';
import { summarize } from '../src/parse/summary';
import { scanUbx } from '../src/parse/ubx';

const enc = (s: string) => new TextEncoder().encode(s);

const TRACK = `$FLYS,1\r
$VAR,FIRMWARE_VER,v2026.05.13\r
$VAR,DEVICE_ID,002f0033343050072036314b\r
$VAR,SESSION_ID,fcce28dd7397ee03aa9839f7\r
$COL,GNSS,time,lat,lon,hMSL,velN,velE,velD,hAcc,vAcc,sAcc,numSV\r
$UNIT,GNSS,,deg,deg,m,m/s,m/s,m/s,m,m,m/s,\r
$DATA\r
$GNSS,2026-09-26T16:41:00.000Z,47.3832204,9.6970507,1000.000,30.000,40.000,10.000,2.000,3.000,0.5,12\r
$GNSS,2026-09-26T16:41:00.100Z,47.3832204,9.6970507,999.000,0.000,0.000,55.000,4.000,5.000,0.5,14\r
$GNSS,2026-09-26T16:41:00.200Z,47.3832204,9.6970507,995.000,0.000,0.000,-3.000,6.000,7.000,0.5,13\r
`;

describe('FlySight CSV', () => {
  it('parses headers and columns', () => {
    const log = parseFlysightCsv(enc(TRACK));
    expect(log.format).toBe('1');
    expect(log.vars.get('DEVICE_ID')).toBe('002f0033343050072036314b');
    const gnss = log.tables.get('GNSS')!;
    expect(gnss.rows).toBe(3);
    expect(gnss.units[3]).toBe('m');
    expect(gnss.data[0][1] - gnss.data[0][0]).toBeCloseTo(0.1, 6);
    expect(gnss.data[10]).toEqual([12, 14, 13]);
  });

  it('summarizes a track', () => {
    const s = summarize('TRACK.CSV', enc(TRACK));
    const f = Object.fromEntries(s.fields.map(([k, v]) => [k, v]));
    expect(s.kind).toBe('GNSS track');
    expect(f['Fixes']).toBe('3');
    expect(f['Sample rate']).toBe('10.0 Hz');
    expect(f['Max horizontal speed']).toMatch(/^180 km\/h/);
    expect(f['Max descent rate']).toMatch(/^198 km\/h/);
    expect(f['Max climb rate']).toMatch(/^11 km\/h/);
    expect(f['Altitude (MSL)']).toBe('995 – 1000 m');
  });

  it('keeps commas inside event descriptions', () => {
    const csv = '$FLYS,1\n$COL,EVNT,time,description\n$DATA\n$EVNT,1.5,"a, b"\n';
    const s = summarize('EVENT.CSV', enc(csv));
    expect(s.tables[0].rows).toEqual([['1.500', 'a, b']]);
  });
});

describe('UBX', () => {
  it('counts valid frames and skips garbage', () => {
    const frame = (cls: number, id: number, payload: number[]) => {
      const body = [cls, id, payload.length & 0xff, payload.length >> 8, ...payload];
      let a = 0, b = 0;
      for (const x of body) { a = (a + x) & 0xff; b = (b + a) & 0xff; }
      return [0xb5, 0x62, ...body, a, b];
    };
    const data = Uint8Array.from([0, 1, ...frame(1, 7, [1, 2, 3]), ...frame(1, 7, []), ...frame(2, 0x15, [9])]);
    const u = scanUbx(data);
    expect(u.total).toBe(3);
    expect(u.messages[0]).toMatchObject({ name: 'NAV-PVT', count: 2 });
    expect(u.skippedBytes).toBe(2);
  });
});

// Real files from a card copy, if available (not committed).
const CARD = process.env.FLYSIGHT_DATA ?? join(homedir(), 'flysight/fly2');
const sessions = existsSync(CARD)
  ? readdirSync(CARD)
      .filter((d) => /^\d\d-\d\d-\d\d$/.test(d))
      .flatMap((d) => readdirSync(join(CARD, d)).map((t) => join(CARD, d, t)))
  : [];

describe.skipIf(sessions.length === 0)(`real card data (${CARD})`, () => {
  it.each(sessions.slice(0, 5))('summarizes %s', (dir) => {
    for (const name of readdirSync(dir)) {
      const s = summarize(name, readFileSync(join(dir, name)));
      expect(s.fields.length).toBeGreaterThan(0);
      if (name === 'TRACK.CSV') {
        expect(s.kind).toBe('GNSS track');
        expect(s.fields.find(([k]) => k === 'Device ID')).toBeTruthy();
      }
      if (name === 'RAW.UBX') {
        // Real logs carry the odd corrupt frame from receiver start-up
        expect(s.fields.find(([k]) => k === 'UBX messages')?.[1]).not.toBe('0');
      }
    }
  });
});
