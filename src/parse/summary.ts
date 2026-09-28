/**
 * Turn a downloaded file into a small, display-ready summary.
 *
 * Summaries are plain data (label/value pairs and simple tables) so the UI
 * can render any file type the same way.
 */
import { column, isFlysightCsv, parseFlysightCsv, type FlysightLog, type FlysightTable } from './flysight';
import { scanUbx } from './ubx';

export interface SummaryTable {
  title: string;
  headers: string[];
  rows: string[][];
}

export interface Summary {
  kind: string;
  fields: [label: string, value: string, href?: string][];
  tables: SummaryTable[];
  warnings: string[];
  /** Plain-text preview for text files. */
  preview?: string;
}

export function summarize(name: string, data: Uint8Array): Summary {
  const upper = name.toUpperCase();
  if (isFlysightCsv(data)) {
    const log = parseFlysightCsv(data);
    if (log.tables.has('GNSS')) return summarizeTrack(log);
    if (log.tables.has('EVNT')) return summarizeEvents(log);
    return summarizeSensors(log);
  }
  if (upper.endsWith('.UBX')) return summarizeUbx(data);
  if (upper.endsWith('.TXT') || upper.endsWith('.CSV') || looksLikeText(data)) return summarizeText(data);
  return { kind: 'Binary file', fields: [['Size', formatBytes(data.length)]], tables: [], warnings: [] };
}

function summarizeTrack(log: FlysightLog): Summary {
  const gnss = log.tables.get('GNSS')!;
  const s: Summary = { kind: 'GNSS track', fields: headerFields(log), tables: [], warnings: [] };
  const time = column(gnss, 'time') ?? [];
  const n = gnss.rows;

  s.fields.push(['Fixes', n.toLocaleString()]);
  if (n < 2) {
    s.warnings.push('Track has fewer than two fixes.');
    return s;
  }

  const t0 = time[0];
  const t1 = time[n - 1];
  const duration = t1 - t0;
  s.fields.push(
    ['Start (UTC)', formatUtc(t0)],
    ['End (UTC)', formatUtc(t1)],
    ['Duration', formatDuration(duration)],
    ['Sample rate', `${((n - 1) / duration).toFixed(1)} Hz`],
  );

  const lat = column(gnss, 'lat');
  const lon = column(gnss, 'lon');
  if (lat && lon) {
    const la = lat[0].toFixed(6);
    const lo = lon[0].toFixed(6);
    s.fields.push([
      'Start position',
      `${la}, ${lo}`,
      `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=14/${la}/${lo}`,
    ]);
  }

  const hMSL = column(gnss, 'hMSL');
  if (hMSL) {
    const r = range(hMSL);
    s.fields.push(['Altitude (MSL)', `${r.min.toFixed(0)} – ${r.max.toFixed(0)} m`]);
    s.fields.push(['Altitude gain', `${(r.max - hMSL[0]).toFixed(0)} m above start`]);
  }

  const velN = column(gnss, 'velN');
  const velE = column(gnss, 'velE');
  if (velN && velE) {
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, Math.hypot(velN[i], velE[i]));
    s.fields.push(['Max horizontal speed', formatSpeed(max)]);
  }

  const velD = column(gnss, 'velD');
  if (velD) {
    const r = range(velD);
    s.fields.push(['Max descent rate', formatSpeed(Math.max(r.max, 0))]);
    s.fields.push(['Max climb rate', formatSpeed(Math.max(-r.min, 0))]);
  }

  const numSV = column(gnss, 'numSV');
  if (numSV) {
    const r = range(numSV);
    s.fields.push(['Satellites', `${mean(numSV).toFixed(1)} avg (${r.min}–${r.max})`]);
  }
  const hAcc = column(gnss, 'hAcc');
  const vAcc = column(gnss, 'vAcc');
  if (hAcc && vAcc) {
    s.fields.push(['Accuracy (median)', `${median(hAcc).toFixed(1)} m horiz, ${median(vAcc).toFixed(1)} m vert`]);
  }

  // Gaps: intervals much longer than the typical sample period
  const period = duration / (n - 1);
  let gaps = 0;
  let longest = 0;
  for (let i = 1; i < n; i++) {
    const dt = time[i] - time[i - 1];
    if (dt > Math.max(1, period * 3)) {
      gaps++;
      longest = Math.max(longest, dt);
    }
  }
  if (gaps > 0) s.warnings.push(`${gaps} gap${gaps > 1 ? 's' : ''} in the track (longest ${formatDuration(longest)}).`);

  return s;
}

function summarizeSensors(log: FlysightLog): Summary {
  const s: Summary = { kind: 'Sensor log', fields: headerFields(log), tables: [], warnings: [] };
  const rows: string[][] = [];
  for (const table of log.tables.values()) {
    const time = column(table, 'time');
    const span = time && table.rows > 1 ? time[table.rows - 1] - time[0] : 0;
    rows.push([
      table.type,
      table.rows.toLocaleString(),
      span > 0 ? formatDuration(span) : '—',
      span > 0 ? `${((table.rows - 1) / span).toFixed(1)} Hz` : '—',
      table.columns.filter((c) => c !== 'time').join(', '),
    ]);
  }
  s.tables.push({ title: 'Record types', headers: ['Type', 'Rows', 'Span', 'Rate', 'Columns'], rows });

  addRangeField(s, log.tables.get('VBAT'), 'voltage', 'Battery', (v) => `${v.toFixed(2)} V`);
  addRangeField(s, log.tables.get('BARO'), 'pressure', 'Pressure', (v) => `${(v / 100).toFixed(1)} hPa`);
  addRangeField(s, log.tables.get('BARO'), 'temperature', 'Temperature', (v) => `${v.toFixed(1)} °C`);
  addRangeField(s, log.tables.get('HUM'), 'humidity', 'Humidity', (v) => `${v.toFixed(0)} %`);

  if (log.unknownLines > 0) s.warnings.push(`${log.unknownLines} unrecognised lines.`);
  return s;
}

function summarizeEvents(log: FlysightLog): Summary {
  const s: Summary = { kind: 'Event log', fields: headerFields(log), tables: [], warnings: [] };
  const evnt = log.tables.get('EVNT')!;
  const time = column(evnt, 'time') ?? [];
  const text = evnt.text.get('description') ?? [];
  s.fields.push(['Events', evnt.rows.toLocaleString()]);
  s.tables.push({
    title: 'Events',
    headers: ['Time (s)', 'Description'],
    rows: text.map((d, i) => [time[i].toFixed(3), d]),
  });
  return s;
}

function summarizeUbx(data: Uint8Array): Summary {
  const u = scanUbx(data);
  const s: Summary = {
    kind: 'u-blox raw log',
    fields: [
      ['Size', formatBytes(data.length)],
      ['UBX messages', u.total.toLocaleString()],
    ],
    tables: [
      {
        title: 'Messages',
        headers: ['Message', 'Count', 'Bytes'],
        rows: u.messages.map((m) => [m.name, m.count.toLocaleString(), formatBytes(m.bytes)]),
      },
    ],
    warnings: [],
  };
  if (u.badChecksums > 0) s.warnings.push(`${u.badChecksums} frame${u.badChecksums > 1 ? 's' : ''} with a bad checksum.`);
  if (u.skippedBytes > 0) s.warnings.push(`${formatBytes(u.skippedBytes)} outside valid UBX frames.`);
  return s;
}

function summarizeText(data: Uint8Array): Summary {
  const text = new TextDecoder('latin1').decode(data.subarray(0, 64 * 1024));
  const lines = text.split('\n');
  return {
    kind: 'Text file',
    fields: [['Size', formatBytes(data.length)]],
    tables: [],
    warnings: data.length > 64 * 1024 ? ['Preview shows the first 64 KB.'] : [],
    preview: lines.slice(0, 500).join('\n'),
  };
}

function headerFields(log: FlysightLog): Summary['fields'] {
  const f: Summary['fields'] = [];
  const fw = log.vars.get('FIRMWARE_VER');
  const dev = log.vars.get('DEVICE_ID');
  const ses = log.vars.get('SESSION_ID');
  if (fw) f.push(['Firmware', fw]);
  if (dev) f.push(['Device ID', dev]);
  if (ses) f.push(['Session ID', ses]);
  return f;
}

function addRangeField(
  s: Summary,
  table: FlysightTable | undefined,
  name: string,
  label: string,
  fmt: (v: number) => string,
): void {
  const col = table && column(table, name);
  if (!col || col.length === 0) return;
  const r = range(col);
  if (Number.isFinite(r.min)) s.fields.push([label, `${fmt(r.min)} – ${fmt(r.max)}`]);
}

function range(values: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? NaN;
}

function looksLikeText(data: Uint8Array): boolean {
  const n = Math.min(data.length, 512);
  for (let i = 0; i < n; i++) {
    const c = data[i];
    if (c < 9 || (c > 13 && c < 32)) return false;
  }
  return n > 0;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${seconds < 10 ? seconds.toFixed(1) : sec}s`;
}

function formatSpeed(ms: number): string {
  return `${(ms * 3.6).toFixed(0)} km/h (${ms.toFixed(1)} m/s)`;
}

function formatUtc(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return '—';
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
