/**
 * "Get new jumps": which sessions on a FlySight are newer than anything
 * already downloaded from it. Sessions live in /YY-MM-DD/HH-MM-SS/ folders,
 * whose names sort chronologically.
 */
import type { CrsClient, DirEntry } from './ble/crs';
import { joinPath } from './fs/fat';

const DATE = /^\d\d-\d\d-\d\d$/;
const TIME = /^\d\d-\d\d-\d\d$/;
const SESSION_PATH = /^\/?(\d\d-\d\d-\d\d)\/(\d\d-\d\d-\d\d)(\/|$)/;

export interface NewSession {
  /** "/YY-MM-DD/HH-MM-SS" */
  dir: string;
  /** Path of the session's TRACK.CSV. */
  path: string;
  track: DirEntry;
}

/** "YY-MM-DD/HH-MM-SS" of the newest session among cached file paths, or null. */
export function newestSession(paths: Iterable<string>): string | null {
  let newest: string | null = null;
  for (const p of paths) {
    const m = SESSION_PATH.exec(p);
    if (!m) continue;
    const key = `${m[1]}/${m[2]}`;
    if (newest === null || key > newest) newest = key;
  }
  return newest;
}

/**
 * TRACK.CSV of every session newer than the newest cached one, oldest first.
 * With nothing cached from this device, only the most recent day's sessions.
 * Only lists the folders it needs, newest first.
 */
export async function findNewSessions(client: CrsClient, cachedPaths: string[]): Promise<NewSession[]> {
  const newest = newestSession(cachedPaths);
  const cached = new Set(cachedPaths.map((p) => (p.startsWith('/') ? p : `/${p}`).toUpperCase()));
  const dates = (await client.listDir('/'))
    .filter((e) => e.isDir && DATE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  const days = newest === null ? dates.slice(0, 1) : dates.filter((d) => d >= newest.slice(0, 8));

  const found: NewSession[] = [];
  for (const date of days) {
    const dateDir = joinPath('/', date);
    const times = (await client.listDir(dateDir))
      .filter((e) => e.isDir && TIME.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const time of times) {
      if (newest !== null && `${date}/${time}` <= newest) break;
      const dir = joinPath(dateDir, time);
      const track = (await client.listDir(dir)).find((e) => !e.isDir && e.name.toUpperCase() === 'TRACK.CSV');
      const path = track && joinPath(dir, track.name);
      if (!track || track.size === 0 || cached.has(path!.toUpperCase())) continue;
      found.push({ dir, path: path!, track });
    }
  }
  return found.reverse();
}
