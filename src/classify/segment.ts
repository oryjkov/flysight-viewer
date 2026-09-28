/**
 * Jump segmentation, v0: finds jumps in a track and places exit, deploy, open
 * and landing markers following labels/RULES.md. Deliberately simple; it
 * pre-fills the labeller until a measured classifier replaces it.
 */
import type { Discipline, JumpLabel, Marker, Platform } from '../labels/schema';
import { derive, goodFix, isoTime, type Track } from '../track/track';

export const CLASSIFIER_VERSION = '0.1.1';

/** Freefall anchor: vD above this for at least ANCHOR_MIN_S. */
const ANCHOR_VD = 10;
const ANCHOR_MIN_S = 3;
/** Anchors this close, with |v| staying above MERGE_SPEED between, are one jump. */
const MERGE_GAP_S = 15;
const MERGE_SPEED = 20;
/** Exit is at most this long before the anchor starts. */
const EXIT_SEARCH_S = 20;
/** A longer gap between samples is a break in the recording. */
const MAX_GAP_S = 1;
/** Below this (m/s²) the velocity vector is steady: still on the platform. */
const PLATFORM_ACCEL = 1.5;
/** Canopy speed: the opening ends at the first |v| minimum below this. */
const CANOPY_SPEED = 15;
/** Drag above this (g) is the opening deceleration. */
const OPENING_DRAG = 1.3;
/** Ground: |v| and |vD| below these for GROUND_MIN_S. */
const GROUND_SPEED = 3;
const GROUND_VD = 1.5;
const GROUND_MIN_S = 10;
/** Climbing faster than this (vD, m/s) at more than FLARE_SPEED is canopy flight. */
const FLARE_CLIMB_VD = -2;
const FLARE_SPEED = 5;

export function segment(track: Track): JumpLabel[] {
  const n = track.length;
  if (n === 0) return [];
  const d = derive(track);
  const good = Uint8Array.from({ length: n }, (_, i) => (goodFix(track, i) ? 1 : 0));
  const vD = smooth(track.t, track.velD, 0.25);
  const vH = smooth(track.t, d.velH, 0.25);
  const speed = smooth(track.t, d.speed, 0.25);
  const drag = smooth(track.t, d.drag, 0.25);
  const vN = smooth(track.t, track.velN, 0.25);
  const vE = smooth(track.t, track.velE, 0.25);
  const t = track.t;
  /** First index with time ≥ `time`. */
  const at = (time: number) => lowerBound(t, time);
  /** Magnitude of the velocity vector's change over the last 0.5 s, m/s². */
  const accelAt = (i: number) => {
    const j = at(t[i] - 0.5);
    const dt = t[i] - t[j];
    return dt > 0 ? Math.hypot(vN[i] - vN[j], vE[i] - vE[j], vD[i] - vD[j]) / dt : Infinity;
  };

  // Freefall anchors.
  const runs: [number, number][] = [];
  for (let i = 0; i < n; ) {
    if (!(good[i] && vD[i] > ANCHOR_VD)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && good[j + 1] && vD[j + 1] > ANCHOR_VD) j++;
    if (t[j] - t[i] >= ANCHOR_MIN_S) runs.push([i, j]);
    i = j + 1;
  }
  const merged: [number, number][] = [];
  for (const run of runs) {
    const prev = merged.at(-1);
    if (prev && t[run[0]] - t[prev[1]] < MERGE_GAP_S && minOf(speed, prev[1], run[0]) > MERGE_SPEED) {
      prev[1] = run[1];
    } else merged.push([...run]);
  }

  const jumps: JumpLabel[] = [];
  let busyUntil = -1;
  for (const [start, end] of merged) {
    // A later anchor inside the previous jump is a canopy turn, not a jump.
    if (start <= busyUntil) continue;

    // Exit: walking back from the anchor, the last sample where the velocity
    // vector stops changing. On a platform it is nearly constant (aircraft in
    // steady flight, even descending on jump run; standing on an object);
    // after exit gravity and drag change it by several m/s².
    // Not found — the recording starts, or resumes after a gap (no fix inside
    // the aircraft), mid-jump — means the exit isn't in the recording.
    let exit = start;
    const exitLimit = at(t[start] - EXIT_SEARCH_S);
    while (exit > exitLimit && t[exit] - t[exit - 1] <= MAX_GAP_S && accelAt(exit) > PLATFORM_ACCEL) exit--;
    if (accelAt(exit) > PLATFORM_ACCEL) exit = -1;
    let platform: Platform;
    if (exit >= 0) {
      const before = median(vH, at(t[exit] - 30), at(t[exit] - 2));
      platform = before > 20 ? 'aircraft' : before < 2 ? 'object' : 'other';
    } else {
      // Without the exit, guess from the height of the jump.
      platform = track.alt[start] - minOf(track.alt, start, n - 1) > 2000 ? 'aircraft' : 'other';
    }

    // Open: first |v| minimum after |v| drops below canopy speed.
    let open = -1;
    const openLimit = at(t[end] + 120);
    for (let i = end; i < openLimit; i++) {
      if (speed[i] < CANOPY_SPEED) {
        open = i;
        while (open + 1 < n && speed[open + 1] < speed[open]) open++;
        break;
      }
    }

    // Deploy: last sample before the opening deceleration.
    let deploy = -1;
    if (open >= 0) {
      let i = open;
      const limit = Math.max(exit, at(t[open] - 20));
      while (i > limit && drag[i] <= OPENING_DRAG) i--;
      while (i > exit && drag[i] > OPENING_DRAG) i--;
      if (i > exit) deploy = i;
    }

    // Landing: last sample before the first stretch of ground.
    let landing = -1;
    const from = open >= 0 ? open : end;
    let groundStart = -1;
    for (let i = from; i < n; i++) {
      if (speed[i] < GROUND_SPEED && Math.abs(vD[i]) < GROUND_VD) {
        if (groundStart < 0) groundStart = i;
        if (t[i] - t[groundStart] >= GROUND_MIN_S) break;
      } else groundStart = -1;
      if (i === n - 1) groundStart = -1;
    }
    if (groundStart > 0) {
      landing = groundStart;
      // Walk back over ground samples, stopping at the canopy: still
      // descending, or clearly climbing at canopy speed (a flare that gains
      // height before touchdown). Small negative vD — GPS noise, altitude
      // drift, walking uphill — is ground.
      while (landing > from) {
        const flare = vD[landing] <= FLARE_CLIMB_VD && vH[landing] > FLARE_SPEED;
        if (vD[landing] >= 0.5 || flare) break;
        landing--;
      }
    }

    jumps.push({
      platform,
      discipline: discipline(vH, vD, good, at(t[exit >= 0 ? exit : start] + 10), deploy >= 0 ? deploy : end),
      exit: marker(track, exit),
      deploy: marker(track, deploy),
      open: marker(track, open),
      landing: marker(track, landing),
      flags: [],
      note: '',
    });
    busyUntil = landing >= 0 ? landing : n;
  }
  return jumps;
}

function discipline(vH: Float64Array, vD: Float64Array, good: Uint8Array, from: number, to: number): Discipline {
  const ratios: number[] = [];
  for (let i = from; i < to; i++) if (good[i] && vD[i] > 5) ratios.push(vH[i] / vD[i]);
  const gr = medianOf(ratios);
  return gr > 1.5 ? 'wingsuit' : gr > 0.5 ? 'tracking' : 'freefall';
}

function marker(track: Track, i: number): Marker | null {
  return i >= 0 ? { t: isoTime(track, i) } : null;
}

/** Moving average over ±`half` seconds. */
export function smooth(t: Float64Array, v: Float64Array, half: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  let lo = 0;
  let hi = -1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    while (hi + 1 < n && t[hi + 1] <= t[i] + half) sum += v[++hi];
    while (t[lo] < t[i] - half) sum -= v[lo++];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, a.length - 1);
}

function minOf(a: Float64Array, from: number, to: number): number {
  let m = Infinity;
  for (let i = from; i <= to; i++) m = Math.min(m, a[i]);
  return m;
}

function median(a: Float64Array, from: number, to: number): number {
  return medianOf(Array.from(a.subarray(from, Math.max(from, to))));
}

function medianOf(values: number[]): number {
  if (values.length === 0) return NaN;
  values.sort((x, y) => x - y);
  return values[values.length >> 1];
}
