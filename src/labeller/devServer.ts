/**
 * API behind the labeller (labeller.html): serves track files from a local
 * data folder and reads/writes label files in the repo. Mounted on the Vite
 * dev server by vite.config.ts; nothing of it reaches the build.
 *
 *   GET /api/tracks             tracks with a GPS fix, and their label status
 *   GET /api/file?path=…        raw file from the data folder
 *   GET /api/labels/<sha256>    label file, 404 if none
 *   PUT /api/labels/<sha256>    validate and write a label file
 *   DELETE /api/labels/<sha256> remove a label file: back to not labelled
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative, resolve, sep } from 'node:path';
import { validateLabel, type LabelStatus, type TrackLabel } from '../labels/schema';
import { countGoodFixes, parseTrack } from '../track/track';

export interface TrackInfo {
  /** Relative to the data folder, with forward slashes. */
  path: string;
  sha256: string;
  /** SENSOR.CSV next to the track, if any. */
  sensor: string | null;
  /** Unix seconds of the first and last sample. */
  start: number;
  end: number;
  status: LabelStatus | null;
  jumps: number | null;
}

/** Tracks with fewer usable fixes than this aren't listed. */
const MIN_GOOD_FIXES = 50;
const MIN_SIZE = 5000;
const TRACK_NAME = /^(TRACK\.CSV|\d\d-\d\d-\d\d\.CSV)$/;

interface Scanned {
  key: string;
  sha256: string;
  start: number;
  end: number;
  usable: boolean;
}

/** Request handler for /api/…; responds 404 to unknown API paths. */
export function createLabellerApi(options: {
  dataDir: string;
  labelsDir: string;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const dataDir = resolve(options.dataDir);
  const tracksDir = resolve(options.labelsDir, 'tracks');
  const cache = new Map<string, Scanned>();
  const user = gitUser();

  async function listTracks(): Promise<TrackInfo[]> {
    const labels = await readLabels(tracksDir);
    const seen = new Set<string>();
    const out: TrackInfo[] = [];
    for (const file of await findTracks(dataDir)) {
      const st = await stat(file);
      const key = `${st.size}:${st.mtimeMs}`;
      let scanned = cache.get(file);
      if (scanned?.key !== key) {
        const bytes = await readFile(file);
        const track = parseTrack(bytes);
        scanned = {
          key,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          start: track.t[0] ?? 0,
          end: track.t[track.length - 1] ?? 0,
          usable: countGoodFixes(track) >= MIN_GOOD_FIXES,
        };
        cache.set(file, scanned);
      }
      if (!scanned.usable || seen.has(scanned.sha256)) continue;
      seen.add(scanned.sha256);
      const label = labels.get(scanned.sha256);
      const sensor = join(file, '..', 'SENSOR.CSV');
      out.push({
        path: toPosix(relative(dataDir, file)),
        sha256: scanned.sha256,
        sensor: file.endsWith('TRACK.CSV') && existsSync(sensor) ? toPosix(relative(dataDir, sensor)) : null,
        start: scanned.start,
        end: scanned.end,
        status: label?.status ?? null,
        jumps: label ? label.jumps.length : null,
      });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/tracks' && req.method === 'GET') {
      return json(res, 200, await listTracks());
    }
    if (url.pathname === '/api/file' && req.method === 'GET') {
      const file = resolve(dataDir, url.searchParams.get('path') ?? '');
      if (!file.startsWith(dataDir + sep) || !existsSync(file)) return json(res, 404, { error: 'not found' });
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(await readFile(file));
      return;
    }
    const m = /^\/api\/labels\/([0-9a-f]{64})$/.exec(url.pathname);
    if (m) {
      const file = join(tracksDir, `${m[1]}.json`);
      if (req.method === 'GET') {
        if (!existsSync(file)) return json(res, 404, { error: 'no label' });
        res.setHeader('Content-Type', 'application/json');
        res.end(await readFile(file));
        return;
      }
      if (req.method === 'DELETE') {
        await rm(file, { force: true });
        return json(res, 200, {});
      }
      if (req.method === 'PUT') {
        const label = JSON.parse(await body(req)) as TrackLabel;
        if (user) label.labelledBy = user;
        label.updatedAt = new Date().toISOString();
        const errors = validateLabel(label);
        if (label.sha256 !== m[1]) errors.push('sha256: does not match the URL');
        if (errors.length) return json(res, 400, { errors });
        await mkdir(tracksDir, { recursive: true });
        await writeFile(file, JSON.stringify(label, null, 2) + '\n');
        return json(res, 200, label);
      }
    }
    json(res, 404, { error: 'not found' });
  }

  return (req, res) => handle(req, res).catch((e: unknown) => json(res, 500, { error: String(e) }));
}

async function findTracks(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // TEMP holds recovered copies of other sessions; dot folders are OS junk.
    if (entry.name.startsWith('.') || entry.name === 'TEMP') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findTracks(path)));
    else if (TRACK_NAME.test(entry.name) && (await stat(path)).size >= MIN_SIZE) out.push(path);
  }
  return out;
}

async function readLabels(dir: string): Promise<Map<string, TrackLabel>> {
  const labels = new Map<string, TrackLabel>();
  if (!existsSync(dir)) return labels;
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const label = JSON.parse(await readFile(join(dir, name), 'utf8')) as TrackLabel;
      labels.set(label.sha256, label);
    } catch {
      // A broken file shows up as unlabelled; saving overwrites it.
    }
  }
  return labels;
}

function gitUser(): string | undefined {
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => ok(data));
    req.on('error', fail);
  });
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}
