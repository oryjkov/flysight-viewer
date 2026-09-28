import { describe, expect, it } from 'vitest';
import { CLASSIFIER_VERSION, segment } from '../src/classify/segment';
import { analyzeJump } from '../src/jump/analyze';
import { validateLabel } from '../src/labels/schema';
import { clockOffset } from '../src/track/sensor';
import { derive, G, indexOfTime, isoTime, parseTrack, type Track } from '../src/track/track';

const enc = (s: string) => new TextEncoder().encode(s);

const FS1 = `time,lat,lon,hMSL,velN,velE,velD,hAcc,vAcc,sAcc,heading,cAcc,gpsFix,numSV
,(deg),(deg),(m),(m/s),(m/s),(m/s),(m),(m),(m/s),(deg),(deg),,
2026-05-08T08:18:48.10Z,46.9037097,8.6515417,1590.261,-0.07,0.04,0.01,11.026,15.189,0.29,0.00000,125.21526,3,6
2026-05-08T08:18:48.30Z,46.9037100,8.6515409,1589.975,-0.03,0.03,0.05,7.979,7.511,0.28,0.00000,125.21546,3,6
`;

const FS2 = `$FLYS,1\r
$COL,GNSS,time,lat,lon,hMSL,velN,velE,velD,hAcc,vAcc,sAcc,numSV\r
$UNIT,GNSS,,deg,deg,m,m/s,m/s,m/s,m,m,m/s,\r
$DATA\r
$GNSS,2025-09-21T06:58:48.202Z,47.3833408,9.6971815,416.542,0.063,0.077,-0.130,76.496,67.681,1.382,4\r
$GNSS,2025-09-21T06:58:48.400Z,47.3833403,9.6971812,416.490,3.000,4.000,-0.141,67.514,55.660,1.206,12\r
`;

describe('track', () => {
  it('parses FlySight 1 files and normalises centisecond times', () => {
    const track = parseTrack(enc(FS1));
    expect(track.format).toBe('fs1');
    expect(track.length).toBe(2);
    expect(track.alt[1]).toBeCloseTo(1589.975);
    expect(track.numSV[0]).toBe(6);
    expect(isoTime(track, 0)).toBe('2026-05-08T08:18:48.100Z');
    expect(indexOfTime(track, '2026-05-08T08:18:48.300Z')).toBe(1);
    expect(indexOfTime(track, '2026-05-08T08:18:48.200Z')).toBe(-1);
  });

  it('parses FlySight 2 files', () => {
    const track = parseTrack(enc(FS2));
    expect(track.format).toBe('fs2');
    expect(track.length).toBe(2);
    expect(isoTime(track, 0)).toBe('2025-09-21T06:58:48.202Z');
    expect(track.numSV[1]).toBe(12);
    expect(derive(track).velH[1]).toBeCloseTo(5);
  });

  it('computes drag: 1 g at terminal velocity, 0 g in free fall from rest', () => {
    const terminal = synthetic(20, () => ({ vD: 50 }));
    expect(derive(terminal).drag[10]).toBeCloseTo(1);
    const falling = synthetic(20, (t) => ({ vD: G * t }));
    expect(derive(falling).drag[10]).toBeCloseTo(0);
  });
});

describe('sensor clock', () => {
  it('maps sensor time to the track clock by the median offset', () => {
    // Week 2435, 196300 s: 2026-09-08T06:31:40Z on the track's time scale.
    const offset = clockOffset([538.5, 539.5, 540.5], [196300, 196301, 196350], [2435, 2435, 2435])!;
    expect(new Date((538.5 + offset) * 1000).toISOString()).toBe('2026-09-08T06:31:40.000Z');
    expect(clockOffset([1], [0], [0])).toBeNull();
  });
});

describe('segment', () => {
  it('finds exit, deploy, open and landing of a synthetic BASE jump', () => {
    const track = syntheticBase();
    const jumps = segment(track);
    expect(jumps).toHaveLength(1);
    const [j] = jumps;
    const at = (m: 'exit' | 'deploy' | 'open' | 'landing') => (Date.parse(j[m]!.t) - Date.parse(isoTime(track, 0))) / 1000;
    expect(j.platform).toBe('object');
    expect(at('exit')).toBeCloseTo(30, 0);
    expect(at('deploy')).toBeCloseTo(40, 0);
    expect(at('open')).toBeCloseTo(43, 0);
    expect(at('landing')).toBeCloseTo(103, 0);
    const label = { schema: 1, sha256: 'a'.repeat(64), source: '', status: 'unreviewed', jumps, flags: [], note: '' };
    expect(validateLabel({ ...label, prefill: { classifier: CLASSIFIER_VERSION, jumps } })).toEqual([]);
  });

  it('turns the markers into jump stats and series', () => {
    const track = syntheticBase();
    const jump = analyzeJump(track, segment(track)[0]);
    expect(jump.stats.freefallTime).toBeCloseTo(10, 0);
    expect(jump.stats.canopyTime).toBeCloseTo(63, 0);
    // Highest speed up to deploy, which sits just before the 98 m/s peak.
    expect(jump.stats.maxSpeed).toBeGreaterThan(94);
    expect(jump.stats.maxSpeed).toBeLessThanOrEqual(98);
    // Ground is the landing altitude: 1500 m minus everything lost on the way.
    expect(jump.ground).toBeCloseTo(track.alt[jump.landing!]);
    // Drag-free freefall: height lost is ½·g·t² over the freefall time.
    const ff = jump.stats.freefallTime!;
    expect(jump.stats.exitAgl! - jump.stats.deployAgl!).toBeCloseTo((G * ff * ff) / 2, -1);
    const s = jump.series;
    expect(s.t[0]).toBe(0);
    expect(s.drop[0]).toBe(0);
    // Straight canopy flight north at 6 m/s: distance flown and from exit agree.
    const last = s.t.length - 1;
    expect(s.distance[last]).toBeGreaterThan(300);
    expect(s.distance[last]).toBeCloseTo(s.fromExit[last], -1);
  });

  it('finds no jump in a track without freefall', () => {
    expect(segment(synthetic(60, () => ({ vD: 0, vN: 30 })))).toEqual([]);
  });
});

/**
 * Standing 30 s, freefall 10 s (1 g, drag-free), 3 s opening down to 8 m/s,
 * 60 s canopy, then standing.
 */
function syntheticBase(): Track {
  return synthetic(120, (t) => {
    if (t < 30) return { vD: 0 };
    if (t < 40) return { vD: G * (t - 30) };
    if (t < 43) return { vD: 98 - 30 * (t - 40) };
    if (t < 103) return { vD: 5, vN: 6 };
    return { vD: 0 };
  });
}

/** 10 Hz track with perfect fixes; altitude integrates vD, latitude vN. */
function synthetic(seconds: number, v: (t: number) => { vD: number; vN?: number }): Track {
  const n = seconds * 10;
  const t0 = Date.parse('2026-01-01T00:00:00Z') / 1000;
  const track: Track = {
    format: 'fs2',
    t: new Float64Array(n),
    lat: new Float64Array(n),
    lon: new Float64Array(n),
    alt: new Float64Array(n),
    velN: new Float64Array(n),
    velE: new Float64Array(n),
    velD: new Float64Array(n),
    hAcc: new Float64Array(n).fill(1),
    vAcc: new Float64Array(n).fill(1),
    sAcc: new Float64Array(n).fill(0.3),
    numSV: new Float64Array(n).fill(20),
    length: n,
  };
  let alt = 1500;
  let lat = 46.5;
  for (let i = 0; i < n; i++) {
    const s = v(i / 10);
    track.t[i] = t0 + i / 10;
    track.velD[i] = s.vD;
    track.velN[i] = s.vN ?? 0;
    track.alt[i] = alt;
    track.lat[i] = lat;
    alt -= s.vD / 10;
    lat += (s.vN ?? 0) / 10 / 111195;
  }
  return track;
}
