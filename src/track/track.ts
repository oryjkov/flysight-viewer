/**
 * GNSS track from a FlySight 1 CSV or a FlySight 2 TRACK.CSV, as column arrays
 * plus the derived quantities used for jump segmentation.
 *
 * FlySight 1 files have a header row and a units row:
 *
 *   time,lat,lon,hMSL,velN,velE,velD,hAcc,vAcc,sAcc,heading,cAcc,gpsFix,numSV
 *   ,(deg),(deg),(m),(m/s),(m/s),(m/s),(m),(m),(m/s),(deg),(deg),,
 *   2026-05-08T08:18:48.10Z,46.9037097,8.6515417,1590.261,...
 *
 * FlySight 2 files use $GNSS records (see parse/flysight.ts).
 */
import { column, isFlysightCsv, parseFlysightCsv } from '../parse/flysight';

export const G = 9.80665;

export interface Track {
  format: 'fs1' | 'fs2';
  /** Unix seconds. */
  t: Float64Array;
  lat: Float64Array;
  lon: Float64Array;
  /** Height above mean sea level, m. */
  alt: Float64Array;
  velN: Float64Array;
  velE: Float64Array;
  /** Down is positive, m/s. */
  velD: Float64Array;
  hAcc: Float64Array;
  vAcc: Float64Array;
  sAcc: Float64Array;
  numSV: Float64Array;
  length: number;
}

const COLUMNS = ['lat', 'lon', 'hMSL', 'velN', 'velE', 'velD', 'hAcc', 'vAcc', 'sAcc', 'numSV'] as const;

export function parseTrack(bytes: Uint8Array): Track {
  const cols = isFlysightCsv(bytes) ? fs2Columns(bytes) : fs1Columns(bytes);
  // Drop rows without a time; keep time strictly increasing.
  const keep: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < cols.time.length; i++) {
    const t = cols.time[i];
    if (Number.isFinite(t) && t > last) {
      keep.push(i);
      last = t;
    }
  }
  const pick = (a: ArrayLike<number>) => Float64Array.from(keep, (i) => a[i]);
  return {
    format: cols.format,
    t: pick(cols.time),
    lat: pick(cols.lat),
    lon: pick(cols.lon),
    alt: pick(cols.hMSL),
    velN: pick(cols.velN),
    velE: pick(cols.velE),
    velD: pick(cols.velD),
    hAcc: pick(cols.hAcc),
    vAcc: pick(cols.vAcc),
    sAcc: pick(cols.sAcc),
    numSV: pick(cols.numSV),
    length: keep.length,
  };
}

type Columns = Record<(typeof COLUMNS)[number] | 'time', ArrayLike<number>> & { format: 'fs1' | 'fs2' };

function fs2Columns(bytes: Uint8Array): Columns {
  const gnss = parseFlysightCsv(bytes).tables.get('GNSS');
  const get = (name: string) => (gnss && column(gnss, name)) || [];
  const out: Partial<Columns> = { format: 'fs2', time: get('time') };
  for (const c of COLUMNS) out[c] = get(c);
  return out as Columns;
}

function fs1Columns(bytes: Uint8Array): Columns {
  const lines = new TextDecoder('latin1').decode(bytes).split('\n');
  const header = (lines[0] ?? '').trim().split(',');
  const index = (name: string) => header.indexOf(name);
  const names = ['time', ...COLUMNS] as const;
  const idx = names.map(index);
  const data = names.map(() => [] as number[]);
  for (let l = 1; l < lines.length; l++) {
    const line = lines[l];
    // Data rows start with the date; skips the units row and blank lines.
    if (line.length < 20 || line[4] !== '-') continue;
    const cells = line.trim().split(',');
    names.forEach((_, c) => {
      const cell = idx[c] < 0 ? '' : (cells[idx[c]] ?? '');
      data[c].push(c === 0 ? Date.parse(cell) / 1000 : cell === '' ? NaN : Number(cell));
    });
  }
  const out: Partial<Columns> = { format: 'fs1' };
  names.forEach((n, c) => (out[n] = data[c]));
  return out as Columns;
}

/** Sample time as the label format's ISO string (UTC, milliseconds). */
export function isoTime(track: Track, i: number): string {
  return new Date(Math.round(track.t[i] * 1000)).toISOString();
}

/** Index of the sample at an ISO time, or -1 if no sample has that time. */
export function indexOfTime(track: Track, iso: string): number {
  const ms = Date.parse(iso);
  const i = nearestIndex(track, ms / 1000);
  return i >= 0 && Math.round(track.t[i] * 1000) === ms ? i : -1;
}

/** Index of the sample closest in time to `t` (Unix seconds). */
export function nearestIndex(track: Track, t: number): number {
  const a = track.t;
  if (a.length === 0) return -1;
  let lo = 0;
  let hi = a.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(a[hi] - t) < Math.abs(a[lo] - t) ? hi : lo;
}

/** Whether a sample has a usable fix. */
export function goodFix(track: Track, i: number): boolean {
  return track.sAcc[i] < 3 && !(track.numSV[i] < 5);
}

/** Number of samples with a usable fix. */
export function countGoodFixes(track: Track): number {
  let n = 0;
  for (let i = 0; i < track.length; i++) if (goodFix(track, i)) n++;
  return n;
}

export interface Derived {
  /** Horizontal speed, m/s. */
  velH: Float64Array;
  /** Total speed |v|, m/s. */
  speed: Float64Array;
  /** Rate of change of total speed, m/s². */
  accel: Float64Array;
  /**
   * Aerodynamic drag along the flight path, in g: g·vD/|v| − d|v|/dt.
   * About 1 g in steady freefall, near 1 g in a flare (speed traded for
   * height, not lost), 2–4 g during a canopy opening. It corresponds to the
   * specific force an accelerometer on the jumper measures along the path.
   */
  drag: Float64Array;
}

/**
 * Derivatives use a central difference over ±`halfWindow` seconds, which
 * keeps single-sample GPS noise from dominating.
 */
export function derive(track: Track, halfWindow = 0.3): Derived {
  const n = track.length;
  const velH = new Float64Array(n);
  const speed = new Float64Array(n);
  const accel = new Float64Array(n);
  const drag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    velH[i] = Math.hypot(track.velN[i], track.velE[i]);
    speed[i] = Math.hypot(velH[i], track.velD[i]);
  }
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const t = track.t[i];
    while (track.t[lo] < t - halfWindow) lo++;
    while (hi + 1 < n && track.t[hi + 1] <= t + halfWindow) hi++;
    const dt = track.t[hi] - track.t[lo];
    accel[i] = dt > 0 ? (speed[hi] - speed[lo]) / dt : 0;
    const sinDive = speed[i] > 1 ? track.velD[i] / speed[i] : 0;
    drag[i] = sinDive - accel[i] / G;
  }
  return { velH, speed, accel, drag };
}
