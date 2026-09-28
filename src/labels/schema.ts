/**
 * Label files for jump segmentation: one JSON file per track, stored at
 * labels/tracks/<sha256>.json. The rules for placing markers are in
 * labels/RULES.md.
 */

export const LABEL_SCHEMA_VERSION = 1;

export const PLATFORMS = ['aircraft', 'object', 'other'] as const;
export const DISCIPLINES = ['freefall', 'tracking', 'wingsuit'] as const;
export const STATUSES = ['unreviewed', 'labelled', 'skip'] as const;
export const JUMP_FLAGS = ['cutaway', 'bad-gps'] as const;
export const FILE_FLAGS = ['bad-gps'] as const;
/** Markers in the order they occur within a jump. */
export const MARKERS = ['exit', 'deploy', 'open', 'landing'] as const;

export type Platform = (typeof PLATFORMS)[number];
export type Discipline = (typeof DISCIPLINES)[number];
export type LabelStatus = (typeof STATUSES)[number];
export type JumpFlag = (typeof JUMP_FLAGS)[number];
export type FileFlag = (typeof FILE_FLAGS)[number];
export type MarkerName = (typeof MARKERS)[number];

export interface Marker {
  /** UTC ISO 8601 with milliseconds; equals the time of a track sample. */
  t: string;
  /** Can't be placed within about ±1 s. */
  unsure?: boolean;
}

export interface JumpLabel {
  platform: Platform;
  discipline: Discipline;
  /** null: not in the recording (logger started late / stopped early). */
  exit: Marker | null;
  deploy: Marker | null;
  open: Marker | null;
  landing: Marker | null;
  flags: JumpFlag[];
  note: string;
}

export interface TrackLabel {
  schema: typeof LABEL_SCHEMA_VERSION;
  /** SHA-256 (hex) of the track file's bytes; the file's identity. */
  sha256: string;
  /** Path relative to the data root when labelled. Informational only. */
  source: string;
  status: LabelStatus;
  /** Empty for a labelled file without a jump. */
  jumps: JumpLabel[];
  flags: FileFlag[];
  note: string;
  /** What the classifier suggested before a person reviewed it. */
  prefill?: { classifier: string; jumps: JumpLabel[] };
  labelledBy?: string;
  /** UTC ISO 8601. */
  updatedAt?: string;
}

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/**
 * Normalise a FlySight timestamp to the label format: FlySight 1 writes
 * centiseconds ("…:48.10Z"), FlySight 2 milliseconds ("…:48.202Z").
 */
export function normalizeTime(t: string): string {
  return new Date(t).toISOString();
}

/**
 * Check a parsed label file against the schema and the ordering rules.
 * Returns a list of problems; empty means valid. Does not check that marker
 * times match samples of the track — that needs the track itself.
 */
export function validateLabel(value: unknown): string[] {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`);

  if (!isObject(value)) return ['label: not an object'];
  if (value.schema !== LABEL_SCHEMA_VERSION) err('schema', `expected ${LABEL_SCHEMA_VERSION}`);
  if (typeof value.sha256 !== 'string' || !SHA_RE.test(value.sha256)) {
    err('sha256', 'expected 64 lowercase hex digits');
  }
  if (typeof value.source !== 'string') err('source', 'expected a string');
  checkEnum(value.status, STATUSES, 'status', err);
  checkFlags(value.flags, FILE_FLAGS, 'flags', err);
  if (typeof value.note !== 'string') err('note', 'expected a string');
  if (value.labelledBy !== undefined && typeof value.labelledBy !== 'string') {
    err('labelledBy', 'expected a string');
  }
  if (value.updatedAt !== undefined && !isTime(value.updatedAt)) {
    err('updatedAt', 'expected an ISO timestamp with milliseconds');
  }

  checkJumps(value.jumps, 'jumps', err);
  if (value.prefill !== undefined) {
    if (!isObject(value.prefill)) err('prefill', 'expected an object');
    else {
      if (typeof value.prefill.classifier !== 'string') {
        err('prefill.classifier', 'expected a string');
      }
      checkJumps(value.prefill.jumps, 'prefill.jumps', err);
    }
  }
  return errors;
}

type Report = (path: string, msg: string) => void;

function checkJumps(value: unknown, path: string, err: Report): void {
  if (!Array.isArray(value)) {
    err(path, 'expected an array');
    return;
  }
  let prevEnd: string | null = null;
  value.forEach((jump, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(jump)) {
      err(p, 'expected an object');
      return;
    }
    checkEnum(jump.platform, PLATFORMS, `${p}.platform`, err);
    checkEnum(jump.discipline, DISCIPLINES, `${p}.discipline`, err);
    checkFlags(jump.flags, JUMP_FLAGS, `${p}.flags`, err);
    if (typeof jump.note !== 'string') err(`${p}.note`, 'expected a string');

    // Markers must be strictly increasing, and a jump must start after the
    // previous one ends. ISO timestamps of equal length sort as strings.
    const times: string[] = [];
    for (const name of MARKERS) {
      const m = jump[name];
      if (m === null) continue;
      if (!isObject(m) || !isTime(m.t)) {
        err(`${p}.${name}`, 'expected null or { t: ISO timestamp with milliseconds }');
        continue;
      }
      if (m.unsure !== undefined && typeof m.unsure !== 'boolean') {
        err(`${p}.${name}.unsure`, 'expected a boolean');
      }
      const last = times.at(-1);
      if (last !== undefined && m.t <= last) err(`${p}.${name}`, 'not after the previous marker');
      times.push(m.t);
    }
    if (times.length === 0) err(p, 'a jump needs at least one marker');
    else {
      if (prevEnd !== null && times[0] <= prevEnd) err(p, 'overlaps the previous jump');
      prevEnd = times.at(-1)!;
    }
  });
}

function checkEnum(value: unknown, allowed: readonly string[], path: string, err: Report): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    err(path, `expected one of ${allowed.join(', ')}`);
  }
}

function checkFlags(value: unknown, allowed: readonly string[], path: string, err: Report): void {
  if (!Array.isArray(value)) {
    err(path, 'expected an array');
    return;
  }
  value.forEach((f, i) => checkEnum(f, allowed, `${path}[${i}]`, err));
  if (new Set(value).size !== value.length) err(path, 'duplicate flag');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTime(v: unknown): v is string {
  return typeof v === 'string' && TIME_RE.test(v) && !Number.isNaN(Date.parse(v));
}
