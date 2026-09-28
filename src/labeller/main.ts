/**
 * Jump labeller: step through tracks, correct the classifier's exit / deploy /
 * open / landing markers and save them as label files (labels/RULES.md).
 * Served by the dev-server plugin in devServer.ts.
 */
import './labeller.css';
import { marked } from 'marked';
import rulesMarkdown from '../../labels/RULES.md?raw';
import { CLASSIFIER_VERSION, segment } from '../classify/segment';
import {
  DISCIPLINES,
  MARKERS,
  PLATFORMS,
  type JumpFlag,
  type JumpLabel,
  type MarkerName,
  type TrackLabel,
} from '../labels/schema';
import { parseSensor, type SensorData } from '../track/sensor';
import { derive, indexOfTime, isoTime, nearestIndex, parseTrack, type Derived, type Track } from '../track/track';
import { Chart, fitAxis, lowerBound, type Series, type Span, type VLine } from './chart';
import type { TrackInfo } from './devServer';

const MARKER_COLOR: Record<MarkerName, string> = {
  exit: '#0b6bcb',
  deploy: '#c0392b',
  open: '#d35400',
  landing: '#1e8449',
};
const MARKER_LETTER: Record<MarkerName, string> = { exit: 'E', deploy: 'D', open: 'O', landing: 'L' };
const GHOST = '#8a8a8a';
const OTHER_JUMP = '#9aa3ad';
/** Loupe half-width, s. */
const LOUPE_HALF = 8;
/** Pointer distance, px, that grabs a marker line. */
const GRAB_PX = 7;

const css = getComputedStyle(document.documentElement);
const color = (name: string) => css.getPropertyValue(name).trim();
const COLORS = {
  speed: color('--speed'),
  vD: color('--vd'),
  vH: color('--vh'),
  alt: color('--alt'),
  drag: color('--drag'),
  force: color('--force'),
};

interface Loaded {
  info: TrackInfo;
  track: Track;
  d: Derived;
  sensor: SensorData | null;
  label: TrackLabel;
  /**
   * The current classifier's suggestion, drawn as dashed lines. The label's
   * `prefill` may be older: it records what the labeller started from.
   */
  ghost: JumpLabel[];
  dirty: boolean;
  /** Label just cleared: don't auto-save it again unless edited. */
  cleared: boolean;
  /** Series shared by the charts. */
  s: Record<'speed' | 'vD' | 'vH' | 'alt' | 'drag', Series> & { force: Series | null };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  list: $<HTMLUListElement>('list'),
  filter: $<HTMLSelectElement>('filter'),
  progress: $('progress'),
  path: $('path'),
  status: $('status'),
  dirty: $('dirty'),
  error: $('error'),
  tabs: $('jump-tabs'),
  addJump: $<HTMLButtonElement>('add-jump'),
  jumpFields: $('jump-fields'),
  platform: $<HTMLSelectElement>('platform'),
  discipline: $<HTMLSelectElement>('discipline'),
  cutaway: $<HTMLInputElement>('jump-cutaway'),
  jumpBadGps: $<HTMLInputElement>('jump-bad-gps'),
  jumpNote: $<HTMLInputElement>('jump-note'),
  deleteJump: $<HTMLButtonElement>('delete-jump'),
  fileBadGps: $<HTMLInputElement>('file-bad-gps'),
  fileNote: $<HTMLInputElement>('file-note'),
  noJump: $<HTMLButtonElement>('no-jump'),
  skip: $<HTMLButtonElement>('skip'),
  reset: $<HTMLButtonElement>('reset'),
  save: $<HTMLButtonElement>('save'),
  clear: $<HTMLButtonElement>('clear'),
  autosave: $<HTMLInputElement>('autosave'),
  readout: $('readout'),
};
for (const p of PLATFORMS) ui.platform.add(new Option(p, p));
for (const d of DISCIPLINES) ui.discipline.add(new Option(d, d));

const overview = new Chart($<HTMLCanvasElement>('overview'));
const detail = new Chart($<HTMLCanvasElement>('detail'));
const loupes = new Map<MarkerName, { el: HTMLElement; chart: Chart; center: number | null }>();
for (const el of document.querySelectorAll<HTMLElement>('.loupe')) {
  const name = el.dataset.marker as MarkerName;
  el.style.setProperty('--c', MARKER_COLOR[name]);
  el.innerHTML = `<div class="loupe-head"><strong>${name.toUpperCase()}</strong>
    <button class="rule-help" title="Rule for this marker">?</button>
    <label><input type="checkbox" class="unsure" /> unsure</label>
    <label><input type="checkbox" class="missing" /> not recorded</label>
    <span class="time"></span></div><canvas></canvas>`;
  const chart = new Chart(el.querySelector('canvas')!);
  chart.pad.l = 30;
  chart.pad.r = 30;
  chart.dots = true;
  loupes.set(name, { el, chart, center: null });
}

let tracks: TrackInfo[] = [];
let cur: Loaded | null = null;
let activeJump = 0;
let activeMarker: MarkerName = 'exit';
let loadSeq = 0;
let hoverT: number | null = null;
/** Chart the pointer is over; it shows the values at the cursor. */
let hoverChart: Chart | null = null;

// ---------------------------------------------------------------- loading

async function start(): Promise<void> {
  tracks = await (await fetch('/api/tracks')).json();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const first = tracks.findIndex((t) => t.path === fromHash);
  const todo = tracks.findIndex((t) => t.status === null || t.status === 'unreviewed');
  renderList();
  if (tracks.length) await open(first >= 0 ? first : Math.max(0, todo));
  else ui.path.textContent = 'No tracks found in the data folder.';
}

async function open(index: number): Promise<void> {
  const info = tracks[index];
  const seq = ++loadSeq;
  ui.path.textContent = `${info.path} — loading…`;
  const [bytes, labelRes] = await Promise.all([
    fetch(`/api/file?path=${encodeURIComponent(info.path)}`).then((r) => r.arrayBuffer()),
    fetch(`/api/labels/${info.sha256}`),
  ]);
  if (seq !== loadSeq) return;
  const track = parseTrack(new Uint8Array(bytes));
  const d = derive(track);
  const suggested = segment(track);
  const label: TrackLabel = labelRes.ok ? await labelRes.json() : newLabel(info, suggested);
  cur = {
    info,
    track,
    d,
    sensor: null,
    label,
    ghost: suggested,
    dirty: false,
    cleared: false,
    s: {
      speed: { t: track.t, v: d.speed, color: COLORS.speed, axis: 'left', width: 1.5 },
      vD: { t: track.t, v: track.velD, color: COLORS.vD, axis: 'left' },
      vH: { t: track.t, v: d.velH, color: COLORS.vH, axis: 'left' },
      alt: { t: track.t, v: track.alt, color: COLORS.alt, axis: 'right' },
      drag: { t: track.t, v: d.drag, color: COLORS.drag, axis: 'right' },
      force: null,
    },
  };
  activeJump = 0;
  activeMarker = 'exit';
  history.replaceState(null, '', `#${encodeURIComponent(info.path)}`);
  fitView();
  render();

  if (info.sensor) {
    const sensorBytes = await fetch(`/api/file?path=${encodeURIComponent(info.sensor)}`).then((r) => r.arrayBuffer());
    if (seq !== loadSeq || !cur) return;
    cur.sensor = parseSensor(new Uint8Array(sensorBytes));
    if (cur.sensor) cur.s.force = { t: cur.sensor.t, v: cur.sensor.force, color: COLORS.force, axis: 'right' };
    renderLoupes();
  }
}

/** Unsaved label pre-filled with the classifier's suggestion. */
function newLabel(info: TrackInfo, suggested: JumpLabel[]): TrackLabel {
  return {
    schema: 1,
    sha256: info.sha256,
    source: info.path,
    status: 'unreviewed',
    jumps: clone(suggested),
    flags: [],
    note: '',
    prefill: { classifier: CLASSIFIER_VERSION, jumps: clone(suggested) },
  };
}

/**
 * Save and mark labelled. Without `force`, only when there is something to
 * record: changes, or a track not yet reviewed.
 */
async function save(loaded: Loaded, force = false): Promise<boolean> {
  const { label } = loaded;
  if (!force && !loaded.dirty && (label.status !== 'unreviewed' || loaded.cleared)) return true;
  if (label.status === 'unreviewed') label.status = 'labelled';
  const res = await fetch(`/api/labels/${label.sha256}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(label),
  });
  if (!res.ok) {
    const { errors, error } = await res.json();
    ui.error.textContent = `Not saved: ${(errors ?? [error]).join('; ')}`;
    return false;
  }
  loaded.label = await res.json();
  loaded.dirty = false;
  loaded.cleared = false;
  loaded.info.status = loaded.label.status;
  loaded.info.jumps = loaded.label.jumps.length;
  return true;
}

async function go(index: number): Promise<void> {
  if (index < 0 || index >= tracks.length) return;
  if (cur && ui.autosave.checked) {
    if (!(await save(cur))) return;
  } else if (cur?.dirty && !confirm('Discard the unsaved changes to this track?')) return;
  ui.error.textContent = '';
  await open(index);
  renderList();
}

/** Step through the tracks shown by the current filter. */
function step(delta: number): void {
  const shown = visibleTracks();
  if (!shown.length) return;
  const i = cur ? shown.indexOf(cur.info) : -1;
  const next = i < 0 ? shown[0] : shown[i + delta];
  if (next) void go(tracks.indexOf(next));
}

async function saveNow(): Promise<void> {
  if (!cur) return;
  if (await save(cur, true)) ui.error.textContent = '';
  render();
  renderList();
}

// Browsing without auto-save: warn before losing edits on reload or close.
addEventListener('beforeunload', (e) => {
  if (cur?.dirty && !ui.autosave.checked) e.preventDefault();
});

addEventListener('pagehide', () => {
  if (!cur?.dirty || !ui.autosave.checked) return;
  if (cur.label.status === 'unreviewed') cur.label.status = 'labelled';
  void fetch(`/api/labels/${cur.label.sha256}`, {
    method: 'PUT',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cur.label),
  });
});

// ---------------------------------------------------------------- editing

function jump(): JumpLabel | undefined {
  return cur?.label.jumps[activeJump];
}

function markerIndex(j: JumpLabel, m: MarkerName): number {
  const marker = j[m];
  if (!marker || !cur) return -1;
  const i = indexOfTime(cur.track, marker.t);
  return i >= 0 ? i : nearestIndex(cur.track, Date.parse(marker.t) / 1000);
}

function changed(): void {
  if (!cur) return;
  cur.dirty = true;
  render();
}

/** Move a marker of the active jump, kept between its neighbours. */
function setMarker(m: MarkerName, index: number): void {
  const j = jump();
  if (!cur || !j) return;
  const [lo, hi] = markerBounds(j, m);
  index = Math.min(hi, Math.max(lo, index));
  const unsure = j[m]?.unsure;
  j[m] = unsure ? { t: isoTime(cur.track, index), unsure } : { t: isoTime(cur.track, index) };
  changed();
}

/** Allowed sample range for a marker: after the previous one, before the next. */
function markerBounds(j: JumpLabel, m: MarkerName): [number, number] {
  const jumps = cur!.label.jumps;
  let lo = 0;
  let hi = cur!.track.length - 1;
  const k = MARKERS.indexOf(m);
  const before = [...MARKERS.slice(0, k).map((x) => markerIndex(j, x))];
  const after = [...MARKERS.slice(k + 1).map((x) => markerIndex(j, x))];
  const prevJump = jumps[jumps.indexOf(j) - 1];
  const nextJump = jumps[jumps.indexOf(j) + 1];
  if (prevJump) before.push(...MARKERS.map((x) => markerIndex(prevJump, x)));
  if (nextJump) after.push(...MARKERS.map((x) => markerIndex(nextJump, x)));
  for (const i of before) if (i >= 0) lo = Math.max(lo, i + 1);
  for (const i of after) if (i >= 0) hi = Math.min(hi, i - 1);
  return [lo, hi];
}

function toggleMissing(m: MarkerName): void {
  const j = jump();
  if (!cur || !j) return;
  if (j[m]) {
    j[m] = null;
    changed();
    return;
  }
  const ghost = cur.ghost.find((g) => g[m])?.[m];
  const t = ghost ? Date.parse(ghost.t) / 1000 : (detail.t0 + detail.t1) / 2;
  setMarker(m, nearestIndex(cur.track, t));
}

function toggleUnsure(m: MarkerName): void {
  const marker = jump()?.[m];
  if (!marker) return;
  if (marker.unsure) delete marker.unsure;
  else marker.unsure = true;
  changed();
}

function addJump(): void {
  if (!cur) return;
  const { track } = cur;
  const at = (f: number) => isoTime(track, nearestIndex(track, detail.t0 + f * (detail.t1 - detail.t0)));
  const j: JumpLabel = {
    platform: 'aircraft',
    discipline: 'freefall',
    exit: { t: at(0.2) },
    deploy: { t: at(0.5) },
    open: { t: at(0.55) },
    landing: { t: at(0.85) },
    flags: [],
    note: '',
  };
  const jumps = cur.label.jumps;
  let i = jumps.findIndex((x) => markerIndex(x, 'exit') > markerIndex(j, 'exit'));
  if (i < 0) i = jumps.length;
  jumps.splice(i, 0, j);
  activeJump = i;
  changed();
}

function deleteJump(): void {
  if (!cur || !jump() || !confirm(`Delete jump ${activeJump + 1}?`)) return;
  cur.label.jumps.splice(activeJump, 1);
  activeJump = Math.max(0, activeJump - 1);
  changed();
}

function setNoJump(): void {
  if (!cur) return;
  if (cur.label.jumps.length && !confirm('Remove all jumps: this file has no jump?')) return;
  cur.label.jumps = [];
  if (cur.label.status === 'skip') cur.label.status = 'labelled';
  activeJump = 0;
  changed();
}

function toggleSkip(): void {
  if (!cur) return;
  cur.label.status = cur.label.status === 'skip' ? 'labelled' : 'skip';
  changed();
}

/** Delete the saved label: the track is not labelled again. */
async function clearLabel(): Promise<void> {
  if (!cur || !confirm('Clear the label of this track? It becomes not labelled.')) return;
  const loaded = cur;
  const res = await fetch(`/api/labels/${loaded.info.sha256}`, { method: 'DELETE' });
  if (!res.ok) {
    ui.error.textContent = 'Not cleared: the server refused';
    return;
  }
  loaded.label = newLabel(loaded.info, loaded.ghost);
  loaded.dirty = false;
  loaded.cleared = true;
  loaded.info.status = null;
  loaded.info.jumps = null;
  activeJump = 0;
  ui.error.textContent = '';
  fitView();
  render();
  renderList();
}

function resetToPrefill(): void {
  if (!cur || !confirm('Replace the jumps with the classifier suggestion?')) return;
  cur.label.jumps = clone(cur.ghost);
  cur.label.prefill = { classifier: CLASSIFIER_VERSION, jumps: clone(cur.ghost) };
  activeJump = 0;
  changed();
}

function toggleJumpFlag(flag: JumpFlag, on: boolean): void {
  const j = jump();
  if (!j) return;
  j.flags = j.flags.filter((f) => f !== flag);
  if (on) j.flags.push(flag);
  changed();
}

// ---------------------------------------------------------------- view

/** Detail range: the active jump with some margin, or the whole track. */
function fitView(): void {
  if (!cur) return;
  const { t } = cur.track;
  const j = jump();
  const idx = j ? MARKERS.map((m) => markerIndex(j, m)).filter((i) => i >= 0) : [];
  if (idx.length) {
    const a = t[Math.min(...idx)];
    const b = t[Math.max(...idx)];
    const margin = Math.max(15, (b - a) * 0.08);
    setView(a - margin, b + margin);
  } else setView(t[0], t[t.length - 1]);
}

function setView(t0: number, t1: number): void {
  if (!cur) return;
  const { t } = cur.track;
  const first = t[0] - 5;
  const last = t[t.length - 1] + 5;
  const width = Math.min(last - first, Math.max(2, t1 - t0));
  t0 = Math.min(Math.max(t0, first), last - width);
  detail.t0 = t0;
  detail.t1 = t0 + width;
}

// ---------------------------------------------------------------- rendering

function render(): void {
  renderHeader();
  renderCharts();
  renderLoupes();
  renderReadout();
}

function visibleTracks(): TrackInfo[] {
  const f = ui.filter.value;
  return tracks.filter((t) =>
    f === 'all'
      ? true
      : f === 'todo'
        ? t.status === null || t.status === 'unreviewed'
        : t.status === f || t === cur?.info,
  );
}

function renderList(): void {
  const shown = visibleTracks();
  ui.list.replaceChildren(
    ...shown.map((t) => {
      const li = document.createElement('li');
      const mark = t.status === 'labelled' ? (t.jumps === 0 ? '∅' : '●') : t.status === 'skip' ? '–' : '○';
      li.innerHTML = `<span class="mark"></span><span class="name"></span><span class="jumps"></span>`;
      li.children[0].textContent = mark;
      li.children[1].textContent = t.path.replace(/\/TRACK\.CSV$/, '');
      li.children[2].textContent = t.jumps ? `${t.jumps}×` : '';
      li.title = `${t.path}\n${t.status ?? 'not labelled'}`;
      li.classList.toggle('current', t === cur?.info);
      li.onclick = () => void go(tracks.indexOf(t));
      return li;
    }),
  );
  ui.list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  const done = tracks.filter((t) => t.status === 'labelled' || t.status === 'skip').length;
  ui.progress.textContent = `${done}/${tracks.length} done`;
}

function renderHeader(): void {
  if (!cur) return;
  const { label, info, track } = cur;
  const mins = ((track.t[track.length - 1] - track.t[0]) / 60).toFixed(1);
  ui.path.textContent = `${info.path} · ${track.format.toUpperCase()} · ${mins} min${cur.sensor ? ' · sensor' : ''}`;
  ui.status.textContent = label.status;
  ui.status.dataset.status = label.status;
  ui.dirty.hidden = !cur.dirty;

  ui.tabs.replaceChildren(
    ...label.jumps.map((j, i) => {
      const b = document.createElement('button');
      b.textContent = `Jump ${i + 1}`;
      b.title = `${j.platform}, ${j.discipline}`;
      b.setAttribute('aria-pressed', String(i === activeJump));
      b.onclick = () => selectJump(i);
      return b;
    }),
  );
  if (!label.jumps.length) {
    const s = document.createElement('span');
    s.textContent = label.status === 'skip' ? 'skipped' : 'no jump';
    ui.tabs.append(s);
  }
  const j = jump();
  ui.jumpFields.hidden = !j;
  if (j) {
    ui.platform.value = j.platform;
    ui.discipline.value = j.discipline;
    ui.cutaway.checked = j.flags.includes('cutaway');
    ui.jumpBadGps.checked = j.flags.includes('bad-gps');
    if (document.activeElement !== ui.jumpNote) ui.jumpNote.value = j.note;
  }
  ui.fileBadGps.checked = label.flags.includes('bad-gps');
  if (document.activeElement !== ui.fileNote) ui.fileNote.value = label.note;
  ui.skip.textContent = label.status === 'skip' ? 'Unskip' : 'Skip';
}

/** Marker lines and phase spans for all jumps; the active one stands out. */
function decorations(): { lines: VLine[]; spans: Span[] } {
  const lines: VLine[] = [];
  const spans: Span[] = [];
  if (!cur) return { lines, spans };
  const { track, label, ghost } = cur;
  const time = (j: JumpLabel, m: MarkerName) => {
    const i = markerIndex(j, m);
    return i >= 0 ? track.t[i] : null;
  };
  for (const g of ghost) {
    for (const m of MARKERS) {
      const t = time(g, m);
      if (t !== null) lines.push({ t, color: GHOST, dash: [3, 3] });
    }
  }
  label.jumps.forEach((j, ji) => {
    const [e, d, o, l] = MARKERS.map((m) => time(j, m));
    const active = ji === activeJump;
    const a = active ? 1 : 0.4;
    if (e !== null && d !== null) spans.push({ t0: e, t1: d, color: `rgba(31, 95, 214, ${0.08 * a})` });
    if (d !== null && o !== null) spans.push({ t0: d, t1: o, color: `rgba(211, 84, 0, ${0.14 * a})` });
    if (o !== null && l !== null) spans.push({ t0: o, t1: l, color: `rgba(30, 132, 73, ${0.08 * a})` });
    for (const m of MARKERS) {
      const t = time(j, m);
      if (t === null) continue;
      lines.push({
        t,
        color: active ? MARKER_COLOR[m] : OTHER_JUMP,
        width: active ? (m === activeMarker ? 3 : 2) : 1,
        dash: j[m]?.unsure ? [6, 3] : undefined,
        label: MARKER_LETTER[m],
      });
    }
  });
  return { lines, spans };
}

function renderCharts(): void {
  if (!cur) return;
  const { s, track } = cur;
  const { lines, spans } = decorations();
  const t0 = track.t[0];
  const t1 = track.t[track.length - 1];

  overview.t0 = t0;
  overview.t1 = t1;
  overview.series = [s.alt, s.vD, s.speed];
  overview.left = fitAxis([s.speed, s.vD], t0, t1, 'm/s');
  overview.right = fitAxis([s.alt], t0, t1, 'm', false);
  overview.spans = spans;
  overview.lines = lines.filter((l) => l.width !== undefined && l.width > 1);
  overview.brush = { t0: detail.t0, t1: detail.t1 };
  overview.draw();

  detail.series = [s.alt, s.vH, s.vD, s.speed];
  detail.left = fitAxis([s.speed, s.vD, s.vH], detail.t0, detail.t1, 'm/s');
  detail.right = fitAxis([s.alt], detail.t0, detail.t1, 'm', false);
  detail.spans = spans;
  detail.lines = lines;
  setCursor(detail);
  detail.draw();
}

function renderLoupes(): void {
  if (!cur) return;
  const { s, track } = cur;
  const j = jump();
  const { lines, spans } = decorations();
  for (const [m, loupe] of loupes) {
    const { el, chart } = loupe;
    el.classList.toggle('active', m === activeMarker);
    const marker = j?.[m] ?? null;
    const unsure = el.querySelector<HTMLInputElement>('.unsure')!;
    const missing = el.querySelector<HTMLInputElement>('.missing')!;
    unsure.checked = !!marker?.unsure;
    unsure.disabled = !marker;
    missing.checked = !!j && !marker;
    missing.disabled = !j;
    const i = j ? markerIndex(j, m) : -1;
    el.querySelector('.time')!.textContent =
      i >= 0 ? `${isoTime(track, i).slice(11, 23)}  ${track.alt[i].toFixed(0)} m` : '';
    if (i < 0) {
      chart.series = [];
      chart.lines = [];
      chart.spans = [];
      chart.title = j ? 'not recorded' : '';
      chart.draw();
      continue;
    }
    // Keep the range fixed while dragging inside the loupe.
    const center = loupe.center ?? track.t[i];
    chart.t0 = center - LOUPE_HALF;
    chart.t1 = center + LOUPE_HALF;
    chart.title = '';
    chart.series = [s.drag, ...(s.force ? [s.force] : []), s.vH, s.vD, s.speed];
    chart.left = fitAxis([s.speed, s.vD, s.vH], chart.t0, chart.t1, 'm/s');
    chart.right = { min: -0.5, max: 4.5, unit: 'g' };
    chart.rightRef = 1;
    chart.spans = spans;
    chart.lines = lines;
    setCursor(chart);
    chart.draw();
  }
}

/**
 * Cursor line at the hovered time on every chart. A hovered loupe also shows
 * the values next to it; the detail chart has the readout line below it.
 */
function setCursor(chart: Chart): void {
  chart.cursor = hoverT;
  const values = hoverT !== null && chart === hoverChart && chart !== detail && cur;
  chart.cursorText = values ? cursorValues(hoverT!) : [];
}

function cursorValues(t: number): { text: string; color: string }[] {
  const { track, d, sensor } = cur!;
  const i = nearestIndex(track, t);
  const f = (v: number) => v.toFixed(1).padStart(6);
  const out = [
    { text: isoTime(track, i).slice(11, 23), color: '' },
    { text: `alt ${track.alt[i].toFixed(0).padStart(6)} m`, color: COLORS.alt },
    { text: `|v| ${f(d.speed[i])} m/s`, color: COLORS.speed },
    { text: `vD  ${f(track.velD[i])} m/s`, color: COLORS.vD },
    { text: `vH  ${f(d.velH[i])} m/s`, color: COLORS.vH },
    { text: `drag ${d.drag[i].toFixed(2).padStart(5)} g`, color: COLORS.drag },
  ];
  if (sensor) {
    const k = Math.min(sensor.t.length - 1, lowerBound(sensor.t, t));
    const j = k > 0 && t - sensor.t[k - 1] < sensor.t[k] - t ? k - 1 : k;
    if (Math.abs(sensor.t[j] - t) < 0.5) {
      out.push({ text: `|a|  ${sensor.force[j].toFixed(2).padStart(5)} g`, color: COLORS.force });
    }
  }
  return out;
}

function renderReadout(): void {
  if (!cur) return;
  if (hoverT === null) {
    ui.readout.replaceChildren();
    return;
  }
  const i = nearestIndex(cur.track, hoverT);
  const parts = [...cursorValues(hoverT), { text: `sAcc ${cur.track.sAcc[i].toFixed(2)}`, color: '' }];
  ui.readout.replaceChildren(
    ...parts.map(({ text, color }) => {
      const span = document.createElement('span');
      span.textContent = text;
      if (color) span.style.color = color;
      return span;
    }),
  );
}

function selectJump(i: number): void {
  if (!cur || i < 0 || i >= cur.label.jumps.length) return;
  activeJump = i;
  fitView();
  render();
}

function selectMarker(m: MarkerName): void {
  activeMarker = m;
  render();
}

// ---------------------------------------------------------------- input

/** Marker of the active jump under x, if any. */
function grab(chart: Chart, x: number): MarkerName | null {
  const j = jump();
  if (!j || !cur) return null;
  let best: MarkerName | null = null;
  let bestDist = GRAB_PX;
  for (const m of MARKERS) {
    const i = markerIndex(j, m);
    if (i < 0) continue;
    const dist = Math.abs(chart.xOf(cur.track.t[i]) - x);
    // Prefer the selected marker when lines overlap.
    if (dist < bestDist || (dist <= bestDist && m === activeMarker)) {
      best = m;
      bestDist = dist;
    }
  }
  return best;
}

function localX(e: PointerEvent | WheelEvent, chart: Chart): number {
  return e.clientX - chart.canvas.getBoundingClientRect().left;
}

{
  let drag: { kind: 'marker'; m: MarkerName } | { kind: 'pan'; x: number; t0: number; t1: number } | null = null;
  const c = detail.canvas;
  c.addEventListener('pointerdown', (e) => {
    const x = localX(e, detail);
    const m = grab(detail, x);
    drag = m ? { kind: 'marker', m } : { kind: 'pan', x, t0: detail.t0, t1: detail.t1 };
    if (m) activeMarker = m;
    c.setPointerCapture(e.pointerId);
    render();
  });
  c.addEventListener('pointermove', (e) => {
    const x = localX(e, detail);
    hoverT = detail.tOf(x);
    hoverChart = detail;
    if (drag?.kind === 'marker' && cur) setMarker(drag.m, nearestIndex(cur.track, hoverT));
    else if (drag?.kind === 'pan') {
      const dt = ((drag.x - x) / detail.plotWidth) * (drag.t1 - drag.t0);
      setView(drag.t0 + dt, drag.t1 + dt);
    }
    c.style.cursor = drag?.kind === 'pan' ? 'grabbing' : grab(detail, x) ? 'col-resize' : 'grab';
    renderCharts();
    renderLoupes();
    renderReadout();
  });
  c.addEventListener('pointerup', () => {
    drag = null;
    render();
  });
  c.addEventListener('pointerleave', clearHover);
  c.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const t = detail.tOf(localX(e, detail));
      const k = Math.pow(1.2, Math.sign(e.deltaY));
      setView(t - (t - detail.t0) * k, t + (detail.t1 - t) * k);
      renderCharts();
    },
    { passive: false },
  );
  c.addEventListener('dblclick', () => {
    fitView();
    render();
  });
}

{
  let from: number | null = null;
  const c = overview.canvas;
  c.addEventListener('pointerdown', (e) => {
    from = overview.tOf(localX(e, overview));
    c.setPointerCapture(e.pointerId);
  });
  c.addEventListener('pointermove', (e) => {
    if (from === null) return;
    const t = overview.tOf(localX(e, overview));
    overview.brush = { t0: Math.min(from, t), t1: Math.max(from, t) };
    overview.draw();
  });
  c.addEventListener('pointerup', (e) => {
    if (from === null) return;
    const t = overview.tOf(localX(e, overview));
    const px = Math.abs(overview.xOf(t) - overview.xOf(from));
    if (px < 4) {
      // Click: centre the detail view here.
      const w = detail.t1 - detail.t0;
      setView(t - w / 2, t + w / 2);
    } else setView(Math.min(from, t), Math.max(from, t));
    from = null;
    render();
  });
}

for (const [m, loupe] of loupes) {
  const c = loupe.chart.canvas;
  let dragging = false;
  const move = (e: PointerEvent) => {
    if (!cur || !jump()?.[m]) return;
    setMarker(m, nearestIndex(cur.track, loupe.chart.tOf(localX(e, loupe.chart))));
  };
  c.addEventListener('pointerdown', (e) => {
    activeMarker = m;
    const j = jump();
    if (!cur || !j?.[m]) return render();
    loupe.center = cur.track.t[markerIndex(j, m)];
    dragging = true;
    c.setPointerCapture(e.pointerId);
    move(e);
  });
  c.addEventListener('pointermove', (e) => {
    hoverT = loupe.chart.tOf(localX(e, loupe.chart));
    hoverChart = loupe.chart;
    if (dragging) move(e);
    else {
      renderCharts();
      renderLoupes();
      renderReadout();
    }
  });
  c.addEventListener('pointerleave', clearHover);
  c.addEventListener('pointerup', () => {
    dragging = false;
    loupe.center = null;
    render();
  });
  loupe.el.querySelector<HTMLButtonElement>('.rule-help')!.onclick = () => openHelp(m);
  loupe.el.querySelector<HTMLInputElement>('.unsure')!.onchange = () => toggleUnsure(m);
  loupe.el.querySelector<HTMLInputElement>('.missing')!.onchange = () => toggleMissing(m);
}

// ---------------------------------------------------------------- rules

const helpPanel = $('help-panel');
const rulesEl = $('rules');
rulesEl.innerHTML = marked.parse(rulesMarkdown, { async: false });
for (const h of rulesEl.querySelectorAll('h1, h2, h3')) {
  h.id = (h.textContent ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
// Each loupe's tooltip: the first sentence of its marker's rule.
for (const [m, loupe] of loupes) {
  const text = rulesEl.querySelector(`#${m} + p`)?.textContent?.replace(/\s+/g, ' ');
  const first = text?.split(/(?<=\.) /)[0];
  if (first) {
    loupe.el.querySelector('strong')!.title = `${m}: ${first}`;
    loupe.el.querySelector<HTMLElement>('.rule-help')!.title = `${m}: ${first} Click for the full rule.`;
  }
}

/** Show the rules, optionally scrolled to and highlighting one section. */
function openHelp(section?: string): void {
  helpPanel.hidden = false;
  for (const el of rulesEl.querySelectorAll('.hl')) el.classList.remove('hl');
  const heading = section ? rulesEl.querySelector<HTMLElement>(`#${section}`) : null;
  if (!heading) {
    rulesEl.scrollTop = 0;
    return;
  }
  // The heading and everything up to the next heading of the same or higher level.
  const level = Number(heading.tagName[1]);
  for (let el: Element | null = heading; el; el = el.nextElementSibling) {
    if (el !== heading && /^H[1-6]$/.test(el.tagName) && Number(el.tagName[1]) <= level) break;
    el.classList.add('hl');
  }
  heading.scrollIntoView({ block: 'start' });
}

function closeHelp(): void {
  helpPanel.hidden = true;
}

$('help').onclick = () => (helpPanel.hidden ? openHelp() : closeHelp());
$('help-close').onclick = closeHelp;
// Show the rules once on a first visit.
try {
  if (!localStorage.getItem('labeller.rulesSeen')) {
    localStorage.setItem('labeller.rulesSeen', '1');
    openHelp();
  }
} catch {
  // Storage unavailable: don't open it every time.
}

function clearHover(): void {
  hoverT = null;
  hoverChart = null;
  renderCharts();
  renderLoupes();
  renderReadout();
}

ui.filter.onchange = () => renderList();
ui.addJump.onclick = addJump;
ui.deleteJump.onclick = deleteJump;
ui.noJump.onclick = setNoJump;
ui.skip.onclick = toggleSkip;
ui.reset.onclick = resetToPrefill;
ui.save.onclick = () => void saveNow();
ui.clear.onclick = () => void clearLabel();
try {
  ui.autosave.checked = localStorage.getItem('labeller.autosave') !== 'off';
} catch {
  // Storage unavailable: keep the default.
}
ui.autosave.onchange = () => {
  try {
    localStorage.setItem('labeller.autosave', ui.autosave.checked ? 'on' : 'off');
  } catch {
    // Not remembered; still applies to this visit.
  }
};
ui.platform.onchange = () => {
  const j = jump();
  if (j) j.platform = ui.platform.value as JumpLabel['platform'];
  changed();
};
ui.discipline.onchange = () => {
  const j = jump();
  if (j) j.discipline = ui.discipline.value as JumpLabel['discipline'];
  changed();
};
ui.cutaway.onchange = () => toggleJumpFlag('cutaway', ui.cutaway.checked);
ui.jumpBadGps.onchange = () => toggleJumpFlag('bad-gps', ui.jumpBadGps.checked);
ui.jumpNote.oninput = () => {
  const j = jump();
  if (j) j.note = ui.jumpNote.value;
  changed();
};
ui.fileBadGps.onchange = () => {
  if (!cur) return;
  cur.label.flags = ui.fileBadGps.checked ? ['bad-gps'] : [];
  changed();
};
ui.fileNote.oninput = () => {
  if (!cur) return;
  cur.label.note = ui.fileNote.value;
  changed();
};

addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.matches('input[type=text], input:not([type]), textarea, select')) {
    if (e.key === 'Escape') target.blur();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    void saveNow();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const j = jump();
  const k = MARKERS.indexOf(activeMarker);
  switch (e.key) {
    case 'Enter':
      void saveNow();
      break;
    case '?':
      if (helpPanel.hidden) openHelp(activeMarker);
      else closeHelp();
      break;
    case 'Escape':
      closeHelp();
      break;
    case 'a':
      step(-1);
      break;
    case 'd':
      step(1);
      break;
    case 'Tab':
      selectMarker(MARKERS[(k + (e.shiftKey ? 3 : 1)) % 4]);
      break;
    case '1':
    case '2':
    case '3':
    case '4':
      selectMarker(MARKERS[Number(e.key) - 1]);
      break;
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (!cur || !j) break;
      const i = markerIndex(j, activeMarker);
      if (i < 0) break;
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      const target = e.shiftKey ? nearestIndex(cur.track, cur.track.t[i] + dir) : i + dir;
      setMarker(activeMarker, target);
      break;
    }
    case 'u':
      toggleUnsure(activeMarker);
      break;
    case 'n':
      toggleMissing(activeMarker);
      break;
    case '[':
      selectJump(activeJump - 1);
      break;
    case ']':
      selectJump(activeJump + 1);
      break;
    case 'f':
      fitView();
      render();
      break;
    case 'x':
      setNoJump();
      break;
    case 's':
      toggleSkip();
      break;
    default:
      return;
  }
  e.preventDefault();
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

void start();
