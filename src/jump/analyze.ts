/**
 * Numbers and chart series for one jump, from a track and the classifier's
 * markers (see classify/segment.ts).
 */
import type { JumpLabel, MarkerName } from '../labels/schema';
import { derive, indexOfTime, nearestIndex, type Derived, type Track } from '../track/track';

const EARTH_RADIUS = 6371008.8;
/** ISA sea-level air density, kg/m³. */
export const SEA_LEVEL_DENSITY = 1.225;

/** Earth radius used by the standard atmosphere for geopotential height, m. */
const ISA_EARTH_RADIUS = 6356766;

/**
 * ISA air density at a (geometric, GPS) height above mean sea level, kg/m³.
 * Troposphere model, valid below 11 km; the height is converted to the
 * geopotential height the standard atmosphere is defined on.
 */
export function isaDensity(altitude: number): number {
  const h = (ISA_EARTH_RADIUS * altitude) / (ISA_EARTH_RADIUS + altitude);
  return SEA_LEVEL_DENSITY * Math.pow(1 - 2.25577e-5 * h, 4.2559);
}

/**
 * Factor turning a speed at `altitude` into the speed with the same drag at
 * ISA sea level: drag ∝ ρv², so v_sl = v·√(ρ/ρ_sl).
 */
export function seaLevelFactor(altitude: number): number {
  return Math.sqrt(isaDensity(altitude) / SEA_LEVEL_DENSITY);
}

export interface Jump {
  label: JumpLabel;
  /** Sample indices; null when the marker isn't in the recording. */
  exit: number | null;
  deploy: number | null;
  open: number | null;
  landing: number | null;
  /** First and last sample of the jump (exit or first falling sample, landing or end of track). */
  start: number;
  end: number;
  /** Ground elevation, m above sea level: at landing, else the lowest point under canopy. */
  ground: number;
  stats: JumpStats;
  series: JumpSeries;
}

export interface JumpStats {
  exitAlt: number | null;
  exitAgl: number | null;
  /** Exit to deploy, s. */
  freefallTime: number | null;
  /** Highest total speed between exit and deploy, m/s. */
  maxSpeed: number;
  maxVertical: number;
  maxHorizontal: number;
  deployAgl: number | null;
  /** Deploy to landing, s. */
  canopyTime: number | null;
}

/** Per-sample values for the jump's samples [start, end], aligned by index. */
export interface JumpSeries {
  /** Seconds from exit (or from the first sample when exit is missing). */
  t: Float64Array;
  /** Height above ground, m. */
  agl: Float64Array;
  velH: Float64Array;
  velD: Float64Array;
  speed: Float64Array;
  /** vH / vD; NaN while not descending. */
  glide: Float64Array;
  /**
   * Horizontal distance flown since exit, m: horizontal speed integrated
   * over time, so it keeps growing through turns.
   */
  distance: Float64Array;
  /** Straight-line horizontal distance from the exit point, m. */
  fromExit: Float64Array;
  /** seaLevelFactor at each sample's altitude. */
  seaLevel: Float64Array;
  /** Height lost since exit, m. */
  drop: Float64Array;
  /** Track index of the first series sample. */
  offset: number;
}

export function analyzeJump(track: Track, label: JumpLabel, d: Derived = derive(track)): Jump {
  const at = (m: MarkerName) => {
    const marker = label[m];
    if (!marker) return null;
    const i = indexOfTime(track, marker.t);
    return i >= 0 ? i : nearestIndex(track, Date.parse(marker.t) / 1000);
  };
  const exit = at('exit');
  const deploy = at('deploy');
  const open = at('open');
  const landing = at('landing');

  const first = deploy ?? open ?? landing ?? 0;
  const start = exit ?? fallingSince(track, first);
  const end = landing ?? track.length - 1;

  let ground: number;
  if (landing !== null) ground = track.alt[landing];
  else {
    ground = Infinity;
    for (let i = open ?? deploy ?? start; i <= end; i++) ground = Math.min(ground, track.alt[i]);
  }

  const ffEnd = deploy ?? end;
  let maxSpeed = 0;
  let maxVertical = 0;
  let maxHorizontal = 0;
  for (let i = start; i <= ffEnd; i++) {
    maxSpeed = Math.max(maxSpeed, d.speed[i]);
    maxVertical = Math.max(maxVertical, track.velD[i]);
    maxHorizontal = Math.max(maxHorizontal, d.velH[i]);
  }
  const dt = (a: number | null, b: number | null) => (a !== null && b !== null ? track.t[b] - track.t[a] : null);

  return {
    label,
    exit,
    deploy,
    open,
    landing,
    start,
    end,
    ground,
    stats: {
      exitAlt: exit !== null ? track.alt[exit] : null,
      exitAgl: exit !== null ? track.alt[exit] - ground : null,
      freefallTime: dt(exit, deploy),
      maxSpeed,
      maxVertical,
      maxHorizontal,
      deployAgl: deploy !== null ? track.alt[deploy] - ground : null,
      canopyTime: dt(deploy, landing),
    },
    series: series(track, d, start, end, ground),
  };
}

/** Walk back from `i` while the jumper is still falling and samples are contiguous. */
function fallingSince(track: Track, i: number): number {
  while (i > 0 && track.velD[i - 1] > 1 && track.t[i] - track.t[i - 1] <= 1) i--;
  return i;
}

function series(track: Track, d: Derived, start: number, end: number, ground: number): JumpSeries {
  const n = end - start + 1;
  const s: JumpSeries = {
    t: new Float64Array(n),
    agl: new Float64Array(n),
    velH: d.velH.slice(start, end + 1),
    velD: track.velD.slice(start, end + 1),
    speed: d.speed.slice(start, end + 1),
    glide: new Float64Array(n),
    distance: new Float64Array(n),
    fromExit: new Float64Array(n),
    seaLevel: new Float64Array(n),
    drop: new Float64Array(n),
    offset: start,
  };
  const lat0 = (track.lat[start] * Math.PI) / 180;
  for (let k = 0; k < n; k++) {
    const i = start + k;
    s.t[k] = track.t[i] - track.t[start];
    s.agl[k] = track.alt[i] - ground;
    s.seaLevel[k] = seaLevelFactor(track.alt[i]);
    s.glide[k] = track.velD[i] > 0.5 ? d.velH[i] / track.velD[i] : NaN;
    // Equirectangular is plenty over a few kilometres.
    const dy = ((track.lat[i] - track.lat[start]) * Math.PI * EARTH_RADIUS) / 180;
    const dx = ((track.lon[i] - track.lon[start]) * Math.PI * EARTH_RADIUS * Math.cos(lat0)) / 180;
    s.fromExit[k] = Math.hypot(dx, dy);
    if (k > 0) {
      // Trapezoid over the speed; across a gap in the recording, fall back to
      // the straight line between the positions either side.
      const dt = track.t[i] - track.t[i - 1];
      const step =
        dt <= 1
          ? ((d.velH[i] + d.velH[i - 1]) / 2) * dt
          : Math.max(0, s.fromExit[k] - s.fromExit[k - 1]) || 0;
      s.distance[k] = s.distance[k - 1] + step;
    }
    s.drop[k] = track.alt[start] - track.alt[i];
  }
  return s;
}
