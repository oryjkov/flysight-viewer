import './style.css';
import { CrsClient, type DirEntry } from './ble/crs';
import { FakeFlySight } from './ble/fakeDevice';
import type { Link } from './ble/link';
import { BleLink, isWebBluetoothAvailable } from './ble/transport';
import { fakeFsFromFiles } from './demo/folder';
import { ATTR_HIDDEN, ATTR_SYSTEM, joinPath, parentPath } from './fs/fat';
import { formatBytes, formatDuration, summarize, type Summary } from './parse/summary';
import { segment } from './classify/segment';
import { jumpView } from './jump/view';
import * as store from './storage';
import { findNewSessions, type NewSession } from './sync';
import { parseTrack } from './track/track';
import { byId, fill, h } from './ui/dom';

interface Session {
  client: CrsClient;
  deviceId: string;
  deviceName: string;
}

const ui = {
  status: byId('status'),
  connect: byId<HTMLButtonElement>('connect'),
  sync: byId<HTMLButtonElement>('sync'),
  simulate: byId<HTMLButtonElement>('simulate'),
  disconnect: byId<HTMLButtonElement>('disconnect'),
  install: byId<HTMLButtonElement>('install'),
  folderInput: byId<HTMLInputElement>('folder-input'),
  openFile: byId<HTMLButtonElement>('open-file'),
  fileInput: byId<HTMLInputElement>('file-input'),
  notice: byId('notice'),
  refresh: byId<HTMLButtonElement>('refresh'),
  crumbs: byId('crumbs'),
  entries: byId('entries'),
  library: byId('library'),
  viewer: byId('viewer'),
  menu: byId<HTMLButtonElement>('menu'),
  more: byId<HTMLButtonElement>('more'),
  connection: byId('connection'),
  scrim: byId('scrim'),
};

let session: Session | null = null;
let cwd = '/';
let entries: DirEntry[] = [];
let listToken = 0;
let library: store.StoredFileMeta[] = [];
let transfer: AbortController | null = null;
let selectedKey: string | null = null;

// ---------------------------------------------------------------- connection

/** The FlySight connected last, to reconnect without the device chooser. */
interface RememberedDevice {
  id: string;
  name: string;
}

/** How long to look for the remembered FlySight before offering the chooser again. */
const RECONNECT_TIMEOUT_MS = 30_000;

/**
 * Connect with the device chooser, or with `remembered` to the FlySight used
 * last (falling back to the chooser when the browser can't). With `hint`,
 * then look for new sessions and offer them. `chooseAnother` runs when the
 * user picks a different FlySight while the remembered one is being looked for.
 */
async function connectBle(
  hint = true,
  remembered = false,
  chooseAnother: () => void = () => void connectBle(hint),
): Promise<void> {
  clearNotice();
  try {
    const link = (remembered && (await reconnectRemembered(chooseAnother))) || (await chooseDevice());
    if (!link) return;
    setStatus('connecting', `Connecting to ${link.name}…`);
    await startSession(link);
    writeSetting('ble.lastDevice', JSON.stringify({ id: link.id, name: link.name } satisfies RememberedDevice));
    if (hint) void offerNewSessions();
  } catch (e) {
    // Aborted: another attempt has taken over, or the notice already says why.
    if (e instanceof DOMException && e.name === 'AbortError') return;
    setStatus('disconnected', 'Not connected');
    if (e instanceof DOMException && e.name === 'NotFoundError' && /cancel/i.test(e.message)) return;
    showNotice(
      `Could not connect: ${errorMessage(e)}. If this FlySight has not been paired with this computer yet, ` +
        'double-press its button so the green LED pulses, then try again. On Linux, Chrome cannot complete ' +
        'pairing by itself (BlueZ needs a pairing agent): pair once with your desktop Bluetooth settings or ' +
        '"tools/flysight_ble.py pair auto", then connect here.',
      true,
    );
  }
}

async function chooseDevice(): Promise<BleLink> {
  setStatus('connecting', 'Choose your FlySight…');
  return BleLink.request();
}

/**
 * Reconnect to the remembered FlySight without the chooser, waiting for it to
 * wake up. Null when there is none or the browser can't; the notice offers the
 * chooser meanwhile (a chooser needs a fresh tap, so it can't just follow a
 * timeout).
 */
async function reconnectRemembered(chooseAnother: () => void): Promise<BleLink | null> {
  let remembered: RememberedDevice;
  try {
    remembered = JSON.parse(readSetting('ble.lastDevice') ?? 'null');
  } catch {
    return null;
  }
  if (!remembered?.id) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), RECONNECT_TIMEOUT_MS);
  setStatus('connecting', `Looking for ${remembered.name}…`);
  showNotice(`Looking for ${remembered.name}. If it's asleep, press its button.`, false, undefined, {
    label: 'Choose another FlySight',
    run: () => {
      controller.abort(new DOMException('Chose another', 'AbortError'));
      chooseAnother();
    },
  });
  try {
    return await BleLink.reconnect(remembered.id, controller.signal);
  } catch (e) {
    if (controller.signal.reason instanceof Error && controller.signal.reason.message === 'timeout') {
      setStatus('disconnected', 'Not connected');
      showNotice(`${remembered.name} wasn't found nearby. Wake it with its button and try again.`, false, undefined, {
        label: 'Choose another FlySight',
        run: chooseAnother,
      });
      throw new DOMException('Not found', 'AbortError');
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) clearNotice();
  }
}

async function simulateFromFolder(files: FileList): Promise<void> {
  if (files.length === 0) return;
  clearNotice();
  session?.client.disconnect();
  const folder = files[0].webkitRelativePath.split('/')[0] || 'folder';
  // ~1 ms per packet is in the same range as a real BLE link
  const link = new FakeFlySight(fakeFsFromFiles(files), { name: `Simulated · ${folder}`, packetIntervalMs: 1 });
  try {
    await startSession(link);
    void offerNewSessions();
  } catch (e) {
    showNotice(`Simulation failed: ${errorMessage(e)}`, true);
  }
}

async function startSession(link: Link): Promise<void> {
  const client = new CrsClient(link);
  try {
    // Proves the link works end to end, including encryption
    await client.ping();
  } catch (e) {
    client.disconnect();
    throw e;
  }
  session = { client, deviceId: link.id, deviceName: link.name };
  client.onClose = (err) => {
    if (session?.client !== client) return;
    session = null;
    updateConnectionUi();
    renderDevicePanel();
    if (err.message !== 'Closed') showNotice(`${link.name} disconnected.`);
  };
  updateConnectionUi();
  await openDir('/');
}

function updateConnectionUi(): void {
  const connected = session !== null;
  setStatus(connected ? 'connected' : 'disconnected', connected ? session!.deviceName : 'Not connected');
  ui.connect.hidden = connected;
  // A development aid for testing without a FlySight: `npm run dev` only.
  ui.simulate.hidden = connected || !import.meta.env.DEV;
  ui.disconnect.hidden = !connected;
  ui.sync.disabled = transfer !== null || (!connected && !isWebBluetoothAvailable());
  ui.refresh.hidden = !connected;
}

function setStatus(state: string, text: string): void {
  ui.status.dataset.state = state;
  ui.status.textContent = text;
}

// ---------------------------------------------------------------- device browser

async function openDir(path: string): Promise<void> {
  if (!session) return;
  const token = ++listToken;
  cwd = path;
  entries = [];
  renderCrumbs();
  ui.entries.replaceChildren(h('li', { class: 'empty' }, 'Loading…'));
  try {
    const list = await session.client.listDir(path);
    if (token !== listToken) return;
    entries = sortEntries(list, path);
    renderEntries();
  } catch (e) {
    if (token !== listToken) return;
    ui.entries.replaceChildren(h('li', { class: 'empty' }, `Could not list ${path}: ${errorMessage(e)}`));
  }
}

function renderDevicePanel(): void {
  if (session) {
    renderCrumbs();
    renderEntries();
  } else {
    ui.crumbs.replaceChildren();
    ui.entries.replaceChildren(h('li', { class: 'empty' }, 'Connect a FlySight to browse its files.'));
  }
}

function renderCrumbs(): void {
  const parts = cwd.split('/').filter(Boolean);
  const nodes: Node[] = [h('a', { onclick: () => navigate('/') }, 'root')];
  parts.forEach((part, i) => {
    const path = `/${parts.slice(0, i + 1).join('/')}`;
    nodes.push(h('span', {}, '/'), h('a', { onclick: () => navigate(path) }, part));
  });
  ui.crumbs.replaceChildren(...nodes);
}

function renderEntries(): void {
  if (!session) return;
  const rows: HTMLElement[] = [];
  if (cwd !== '/') {
    rows.push(
      h(
        'li',
        { class: 'entry', onclick: () => navigate(parentPath(cwd)) },
        h('span', { class: 'glyph' }, '↰'),
        h('span', { class: 'name' }, '..'),
        h('span'),
      ),
    );
  }
  for (const entry of entries) rows.push(renderEntry(entry));
  if (entries.length === 0) rows.push(h('li', { class: 'empty' }, 'Empty folder.'));
  ui.entries.replaceChildren(...rows);
  ui.entries.classList.toggle('locked', transfer !== null);
}

function renderEntry(entry: DirEntry): HTMLElement {
  const path = joinPath(cwd, entry.name);
  const hidden = (entry.attr & (ATTR_HIDDEN | ATTR_SYSTEM)) !== 0;
  const cached = !entry.isDir && cachedMatch(path, entry.size);
  const label = friendlyLabel(entry, cwd);
  const key = session ? store.fileKey(session.deviceId, path) : '';

  return h(
    'li',
    {
      class: `entry${hidden ? ' dim' : ''}${key === selectedKey ? ' selected' : ''}`,
      title: entry.modified ? `Modified ${entry.modified}` : undefined,
      onclick: () => (entry.isDir ? navigate(path) : openRemote(entry, path)),
    },
    h('span', { class: 'glyph' }, entry.isDir ? '📁' : '📄'),
    h(
      'span',
      { class: 'name' },
      entry.name,
      label && h('span', { class: 'label' }, label),
      cached && h('span', { class: 'badge' }, 'cached'),
      isTempPath(path) && entry.isDir && h('span', { class: 'badge live' }, 'unfinished'),
    ),
    h('span', { class: 'meta' }, entry.isDir ? '' : formatBytes(entry.size)),
  );
}

function navigate(path: string): void {
  if (transfer) return;
  void openDir(path);
}

const SESSION_FILE_ORDER = ['TRACK.CSV', 'SENSOR.CSV', 'EVENT.CSV', 'RAW.UBX'];

function sortEntries(list: DirEntry[], dir: string): DirEntry[] {
  const isDate = (e: DirEntry) => e.isDir && /^\d\d-\d\d-\d\d$/.test(e.name);
  const rank = (e: DirEntry) => {
    if (dir === '/' && isDate(e)) return 0; // date folders, newest first
    if (e.isDir) return 1;
    const i = SESSION_FILE_ORDER.indexOf(e.name);
    return i >= 0 ? 2 + i / 10 : 3;
  };
  return [...list].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    // Date and time folders read best newest first
    if (a.isDir && /^\d\d-\d\d-\d\d$/.test(a.name) && /^\d\d-\d\d-\d\d$/.test(b.name)) {
      return b.name.localeCompare(a.name);
    }
    return a.name.localeCompare(b.name);
  });
}

function friendlyLabel(entry: DirEntry, dir: string): string | null {
  const m = /^(\d\d)-(\d\d)-(\d\d)$/.exec(entry.name);
  if (!entry.isDir || !m) return null;
  const depth = dir.split('/').filter(Boolean).length;
  if (depth === 0) {
    const d = new Date(Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  if (depth === 1) return `${m[1]}:${m[2]}:${m[3]}`;
  return null;
}

function isTempPath(path: string): boolean {
  return path.toUpperCase().startsWith('/TEMP/');
}

// ---------------------------------------------------------------- get new jumps

/** Paths already downloaded from the connected FlySight. */
function cachedPaths(deviceId: string): string[] {
  return library.filter((m) => m.deviceId === deviceId).map((m) => m.path);
}

/** After a plain connect: point out sessions newer than the last download. */
async function offerNewSessions(): Promise<void> {
  const s = session;
  if (!s) return;
  try {
    const found = await findNewSessions(s.client, cachedPaths(s.deviceId));
    if (session !== s || transfer || !found.length) return;
    const n = found.length;
    showNotice(`${n} new session${n === 1 ? '' : 's'} on ${s.deviceName}.`, false, undefined, {
      label: 'Get them',
      run: () => void getNewJumps(),
    });
  } catch {
    // Just a hint; browsing still works.
  }
}

/**
 * Connect if needed, then download the TRACK.CSV of every session recorded
 * since the newest one downloaded from this FlySight (only the latest day the
 * first time), and open the newest jump.
 */
async function getNewJumps(chooser = false): Promise<void> {
  if (transfer) return;
  clearNotice();
  closeDrawerOnPhone();
  // The FlySight used last, without the chooser; picking another carries on.
  if (!session) await connectBle(false, !chooser, () => void getNewJumps(true));
  const s = session;
  if (!s || transfer) return;

  const controller = new AbortController();
  transfer = controller;
  ui.sync.disabled = true;
  const wakeLock = await acquireWakeLock();
  const view = renderSync(s.deviceName, () => controller.abort());
  try {
    const found = await findNewSessions(s.client, cachedPaths(s.deviceId));
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (!found.length) {
      view.finish(`No new sessions: everything on ${s.deviceName} up to the newest session is already here.`);
      return;
    }
    const rows = view.list(found);
    let newest: { meta: store.StoredFileMeta; data: Uint8Array } | null = null;
    for (const [i, item] of found.entries()) {
      view.status(`Downloading ${i + 1} of ${found.length}…`);
      const data = await s.client.readFile(item.path, { signal: controller.signal, onProgress: rows[i].progress });
      const meta: store.StoredFileMeta = {
        key: store.fileKey(s.deviceId, item.path),
        deviceId: s.deviceId,
        deviceName: s.deviceName,
        path: item.path,
        size: data.length,
        modified: item.track.modified,
        downloadedAt: Date.now(),
      };
      await store.saveFile(meta, data);
      await refreshLibrary();
      const jumps = countJumps(data);
      rows[i].done(jumps === 0 ? 'no jump' : jumps === 1 ? '1 jump' : `${jumps} jumps`);
      if (jumps > 0 || !newest) newest = { meta, data };
    }
    // Open the newest session with a jump (or the newest at all).
    selectedKey = newest!.meta.key;
    renderLibrary();
    showFile(newest!.meta, newest!.data, `${found.length} new session${found.length === 1 ? '' : 's'} downloaded`);
  } catch (e) {
    const cancelled = e instanceof DOMException && e.name === 'AbortError';
    view.finish(
      cancelled
        ? 'Cancelled. Sessions downloaded so far are kept; Get new jumps continues from there.'
        : `Stopped: ${errorMessage(e)}. Sessions downloaded so far are kept; Get new jumps continues from there.`,
      !cancelled,
    );
  } finally {
    wakeLock?.release().catch(() => {});
    transfer = null;
    updateConnectionUi();
    renderEntries();
  }
}

function countJumps(data: Uint8Array): number {
  try {
    return segment(parseTrack(data)).length;
  } catch {
    return 0;
  }
}

/** Progress view for Get new jumps. */
function renderSync(deviceName: string, cancel: () => void) {
  const statusText = h('div', { class: 'progress-text' }, 'Looking for new sessions…');
  const list = h('ul', { class: 'sync-list' });
  const cancelButton = h('button', { onclick: cancel }, 'Cancel');
  fill(
    ui.viewer,
    h('h3', {}, 'Get new jumps'),
    h('div', { class: 'kind' }, `From ${deviceName}`),
    statusText,
    list,
    h('div', { class: 'actions' }, cancelButton),
  );
  return {
    status(text: string) {
      statusText.textContent = text;
    },
    finish(text: string, error = false) {
      statusText.textContent = text;
      statusText.classList.toggle('error-text', error);
      cancelButton.remove();
    },
    list(found: NewSession[]) {
      return found.map((f) => {
        const bar = h('div');
        const result = h('span', { class: 'sync-result' }, formatBytes(f.track.size));
        list.append(
          h(
            'li',
            {},
            h('span', { class: 'sync-name' }, sessionLabel(f.dir)),
            result,
            h('div', { class: 'progress' }, bar),
          ),
        );
        return {
          progress: (bytes: number) => {
            bar.style.width = `${Math.min(100, (bytes / Math.max(1, f.track.size)) * 100)}%`;
          },
          done: (text: string) => {
            bar.style.width = '100%';
            result.textContent = `✓ ${text}`;
          },
        };
      });
    },
  };
}

/** "/26-09-26/13-34-06" → "Sat 26 Sep · 13:34:06" (the FlySight's local time). */
function sessionLabel(dir: string): string {
  const [date, time] = dir.split('/').filter(Boolean);
  const [y, mo, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(2000 + y, mo - 1, d)).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return `${day} · ${time.replaceAll('-', ':')}`;
}

// ---------------------------------------------------------------- downloads

function openRemote(entry: DirEntry, path: string): void {
  if (!session || transfer) return;
  const cached = library.find((m) => m.key === store.fileKey(session!.deviceId, path));
  if (cached && cached.size === entry.size) void openCached(cached);
  else void download(path, entry);
}

async function download(path: string, entry: Pick<DirEntry, 'size' | 'modified'>): Promise<void> {
  const s = session;
  if (!s || transfer) return;
  const controller = new AbortController();
  transfer = controller;
  selectedKey = store.fileKey(s.deviceId, path);
  closeDrawerOnPhone();
  renderEntries();
  renderLibrary();

  const progress = renderTransfer(path, entry.size, () => controller.abort());
  const started = performance.now();
  const wakeLock = await acquireWakeLock();
  try {
    const data = await s.client.readFile(path, { signal: controller.signal, onProgress: progress });
    const seconds = (performance.now() - started) / 1000;
    const note = `Downloaded in ${formatDuration(seconds)} (${formatBytes(data.length / seconds)}/s)`;
    const meta: store.StoredFileMeta = {
      key: selectedKey,
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      path,
      size: data.length,
      modified: entry.modified,
      downloadedAt: Date.now(),
    };
    const extraWarnings: string[] = [];
    if (data.length !== entry.size) {
      extraWarnings.push(
        `Expected ${formatBytes(entry.size)} from the folder listing but received ${formatBytes(data.length)}.`,
      );
    }
    try {
      await store.saveFile(meta, data);
      await refreshLibrary();
    } catch (e) {
      extraWarnings.push(`Could not cache the file in the browser: ${errorMessage(e)}`);
    }
    showFile(meta, data, note, extraWarnings);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      showMessage(path, 'Download cancelled.');
    } else {
      showMessage(path, `Download failed: ${errorMessage(e)}`, () => download(path, entry));
    }
  } finally {
    wakeLock?.release().catch(() => {});
    transfer = null;
    renderEntries();
  }
}

/**
 * Keep the screen on during a download: on phones the page is suspended when
 * the screen turns off, which drops the Bluetooth connection.
 */
async function acquireWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    return (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    return null;
  }
}

/** Show the progress view; returns a callback for progress updates. */
function renderTransfer(path: string, size: number, cancel: () => void): (bytes: number) => void {
  const bar = h('div');
  const text = h('div', { class: 'progress-text' }, 'Starting…');
  ui.viewer.replaceChildren(
    h('h3', {}, path),
    h('div', { class: 'kind' }, `Downloading from ${session?.deviceName ?? 'FlySight'}`),
    h('div', { class: 'progress' }, bar),
    text,
    h('div', { class: 'actions' }, h('button', { onclick: cancel }, 'Cancel')),
  );

  const started = performance.now();
  let pending = 0;
  let scheduled = false;
  return (bytes) => {
    pending = bytes;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const elapsed = (performance.now() - started) / 1000;
      const rate = pending / Math.max(elapsed, 0.001);
      const pct = size > 0 ? Math.min(100, (pending / size) * 100) : 0;
      const left = rate > 0 && size > pending ? (size - pending) / rate : 0;
      bar.style.width = `${pct}%`;
      text.textContent =
        `${formatBytes(pending)} of ${formatBytes(size)} · ${formatBytes(rate)}/s` +
        (left > 0 && elapsed > 1 ? ` · ${formatDuration(left)} left` : '');
    });
  };
}

async function openCached(meta: store.StoredFileMeta): Promise<void> {
  if (transfer) return;
  selectedKey = meta.key;
  closeDrawerOnPhone();
  renderEntries();
  renderLibrary();
  try {
    const data = await store.loadFile(meta.key);
    if (!data) throw new Error('missing from cache');
    showFile(meta, data, `Cached ${new Date(meta.downloadedAt).toLocaleString()}`);
  } catch (e) {
    showMessage(meta.path, `Could not open cached file: ${errorMessage(e)}`);
  }
}

// ---------------------------------------------------------------- file view

function showFile(meta: store.StoredFileMeta, data: Uint8Array, note: string, extraWarnings: string[] = []): void {
  const name = meta.path.split('/').pop() ?? meta.path;
  let summary: Summary;
  try {
    summary = summarize(name, data);
  } catch (e) {
    summary = { kind: 'Unreadable file', fields: [], tables: [], warnings: [`Could not parse: ${errorMessage(e)}`] };
  }
  const warnings = [...extraWarnings, ...summary.warnings];
  const canRedownload = session?.deviceId === meta.deviceId;
  const jump = isTrackFile(name) ? trackView(data) : null;

  fill(
    ui.viewer,
    jump,
    h('h3', {}, meta.path),
    h('div', { class: 'kind' }, `${summary.kind} · ${formatBytes(data.length)} · ${meta.deviceName} · ${note}`),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'primary', onclick: () => saveToDisk(meta, data) }, 'Save file'),
      canRedownload &&
        h(
          'button',
          { onclick: () => download(meta.path, { size: meta.size, modified: meta.modified }) },
          'Download again',
        ),
      h('button', { onclick: () => removeCached(meta.key) }, 'Remove from browser'),
    ),
    warnings.length > 0 && h('ul', { class: 'warnings' }, ...warnings.map((w) => h('li', {}, w))),
    summary.fields.length > 0 &&
      h(
        'dl',
        { class: 'fields' },
        ...summary.fields.flatMap(([label, value, href]) => [
          h('dt', {}, label),
          h('dd', {}, href ? h('a', { href, target: '_blank', rel: 'noopener' }, value) : value),
        ]),
      ),
    ...summary.tables.flatMap((t) => [
      h('h4', {}, t.title),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ...t.headers.map((x) => h('th', {}, x)))),
          h('tbody', {}, ...t.rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c))))),
        ),
      ),
    ]),
    summary.preview !== undefined && h('pre', { class: 'preview' }, summary.preview),
  );
  if (jump) {
    // The jump comes first; the file's own summary folds away below it.
    const box = h('details', { class: 'file-details' }, h('summary', {}, 'File details'));
    box.append(...ui.viewer.querySelectorAll(':scope > dl.fields, :scope > h4, :scope > .table-wrap, :scope > pre'));
    ui.viewer.append(box);
  }
}

/** FlySight 2 TRACK.CSV, or a FlySight 1 log (HH-MM-SS.CSV). */
function isTrackFile(name: string): boolean {
  return /^(TRACK\.CSV|\d\d-\d\d-\d\d\.CSV)$/i.test(name);
}

function trackView(data: Uint8Array): HTMLElement | null {
  try {
    const track = parseTrack(data);
    return track.length > 0 ? jumpView(track) : null;
  } catch (e) {
    return h('div', { class: 'error-box' }, `Could not analyse the track: ${errorMessage(e)}`);
  }
}

/** Open a track file from disk, keeping it in the library like a download. */
async function openLocalFile(file: File): Promise<void> {
  const data = new Uint8Array(await file.arrayBuffer());
  let path = file.name;
  try {
    const track = parseTrack(data);
    if (track.length) path = `${new Date(track.t[0] * 1000).toISOString().slice(0, 19)}/${file.name}`;
  } catch {
    // Not a track: keep the plain name.
  }
  const meta: store.StoredFileMeta = {
    key: store.fileKey('local', path),
    deviceId: 'local',
    deviceName: 'Opened from disk',
    path,
    size: data.length,
    modified: new Date(file.lastModified).toISOString(),
    downloadedAt: Date.now(),
  };
  const warnings: string[] = [];
  try {
    await store.saveFile(meta, data);
    await refreshLibrary();
  } catch (e) {
    warnings.push(`Could not keep the file in the browser: ${errorMessage(e)}`);
  }
  selectedKey = meta.key;
  closeDrawerOnPhone();
  renderLibrary();
  showFile(meta, data, `Opened ${file.name}`, warnings);
}

function showMessage(path: string, message: string, retry?: () => void): void {
  fill(
    ui.viewer,
    h('h3', {}, path),
    h('div', { class: 'error-box' }, message),
    retry && session && h('div', { class: 'actions' }, h('button', { onclick: retry }, 'Try again')),
  );
}

function saveToDisk(meta: store.StoredFileMeta, data: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>]));
  const a = h('a', { href: url, download: meta.path.replace(/^\//, '').replaceAll('/', '_') });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------- library

async function refreshLibrary(): Promise<void> {
  try {
    library = await store.listFiles();
  } catch (e) {
    library = [];
    showNotice(`Browser storage is unavailable, downloads will not be cached: ${errorMessage(e)}`);
  }
  renderLibrary();
}

function renderLibrary(): void {
  if (library.length === 0) {
    ui.library.replaceChildren(h('li', { class: 'empty' }, 'Nothing downloaded yet.'));
    return;
  }
  ui.library.replaceChildren(
    ...library.map((meta) =>
      h(
        'li',
        { class: `entry${meta.key === selectedKey ? ' selected' : ''}`, onclick: () => openCached(meta) },
        h('span', { class: 'glyph' }, '💾'),
        h('span', { class: 'name', title: meta.path }, meta.path),
        h(
          'span',
          { class: 'meta' },
          formatBytes(meta.size),
          h(
            'button',
            {
              class: 'delete',
              title: 'Remove from browser',
              onclick: (e: Event) => {
                e.stopPropagation();
                void removeCached(meta.key);
              },
            },
            '✕',
          ),
        ),
        h('span', { class: 'sub' }, `${meta.deviceName} · ${new Date(meta.downloadedAt).toLocaleString()}`),
      ),
    ),
  );
}

async function removeCached(key: string): Promise<void> {
  await store.deleteFile(key).catch(() => {});
  if (selectedKey === key) {
    selectedKey = null;
    ui.viewer.replaceChildren(h('div', { class: 'placeholder' }, h('p', {}, 'Removed from the browser cache.')));
  }
  await refreshLibrary();
  renderEntries();
}

function cachedMatch(path: string, size: number): boolean {
  if (!session) return false;
  const key = store.fileKey(session.deviceId, path);
  return library.some((m) => m.key === key && m.size === size);
}

// ---------------------------------------------------------------- misc

/**
 * Show a notice with a close button. With `rememberAs`, closing it is
 * remembered and the notice isn't shown again.
 */
function showNotice(
  message: string,
  error = false,
  rememberAs?: string,
  action?: { label: string; run: () => void },
): void {
  if (rememberAs && readSetting(rememberAs)) return;
  const close = h('button', { class: 'icon notice-close', title: 'Dismiss', 'aria-label': 'Dismiss' }, '×');
  close.onclick = () => {
    if (rememberAs) writeSetting(rememberAs, 'dismissed');
    clearNotice();
  };
  const act =
    action &&
    h('button', { class: 'primary notice-action' }, action.label);
  if (act) {
    act.onclick = () => {
      clearNotice();
      action.run();
    };
  }
  fill(ui.notice, h('span', {}, message), act, close);
  ui.notice.classList.toggle('error', error);
  ui.notice.hidden = false;
}

function clearNotice(): void {
  ui.notice.hidden = true;
}

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; fine for this visit.
  }
}

// ---------------------------------------------------------------- phone layout

/** Matches the CSS breakpoint where the sidebar becomes a drawer. */
const compact = matchMedia('(max-width: 900px), (orientation: landscape) and (max-height: 500px)');

function setDrawer(open: boolean): void {
  document.body.classList.toggle('drawer-open', open);
  ui.scrim.hidden = !open;
  ui.menu.setAttribute('aria-expanded', String(open));
}

/** After picking a file on a phone, get the file list out of the way. */
function closeDrawerOnPhone(): void {
  if (compact.matches) setDrawer(false);
}

function setMoreMenu(open: boolean): void {
  ui.connection.classList.toggle('open', open);
  ui.more.setAttribute('aria-expanded', String(open));
}

ui.menu.addEventListener('click', () => setDrawer(!document.body.classList.contains('drawer-open')));
ui.scrim.addEventListener('click', () => setDrawer(false));
{
  // Swipe the drawer left to close it.
  const sidebar = document.querySelector<HTMLElement>('.sidebar')!;
  let startX: number | null = null;
  sidebar.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') startX = e.clientX;
  });
  sidebar.addEventListener('pointerup', (e) => {
    if (startX !== null && e.clientX - startX < -60) setDrawer(false);
    startX = null;
  });
  sidebar.addEventListener('pointercancel', () => (startX = null));
}
ui.more.addEventListener('click', (e) => {
  e.stopPropagation();
  setMoreMenu(!ui.connection.classList.contains('open'));
});
// Any choice in the menu, or a click elsewhere, closes it.
document.addEventListener('click', (e) => {
  if (!ui.connection.contains(e.target as Node) || (e.target as HTMLElement).closest('button')) setMoreMenu(false);
});
compact.addEventListener('change', () => {
  setDrawer(false);
  setMoreMenu(false);
});
// The jump view's landscape overlay has its own button for the file list.
document.addEventListener('open-files', () => setDrawer(true));
// Landscape chart mode only takes over the screen while a jump is shown.
new MutationObserver(() => {
  document.body.classList.toggle('has-jump', !!ui.viewer.querySelector('.jump-view'));
}).observe(ui.viewer, { childList: true });
{
  // Portrait phones: the top bar slides away while scrolling down and comes
  // back when scrolling up.
  let lastY = scrollY;
  addEventListener(
    'scroll',
    () => {
      const y = scrollY;
      if (!compact.matches || Math.abs(y - lastY) < 6) return;
      const hide = y > lastY && y > 80 && !ui.connection.classList.contains('open');
      document.body.classList.toggle('topbar-hidden', hide);
      lastY = y;
    },
    { passive: true },
  );
}
// With nothing open yet, a phone starts on the file list.
if (compact.matches && ui.viewer.querySelector('.placeholder')) setDrawer(true);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

ui.connect.addEventListener('click', () => void connectBle());
ui.sync.addEventListener('click', () => void getNewJumps());
ui.simulate.addEventListener('click', () => ui.folderInput.click());
ui.openFile.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', () => {
  const file = ui.fileInput.files?.[0];
  ui.fileInput.value = '';
  if (file) void openLocalFile(file);
});
ui.folderInput.addEventListener('change', () => {
  if (ui.folderInput.files) void simulateFromFolder(ui.folderInput.files);
  ui.folderInput.value = '';
});
ui.disconnect.addEventListener('click', () => {
  transfer?.abort();
  session?.client.disconnect();
});
ui.refresh.addEventListener('click', () => navigate(cwd));
window.addEventListener('beforeunload', (e) => {
  if (transfer) e.preventDefault();
});

// Chrome's install prompt event; not in TypeScript's DOM types.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Chrome on Android rarely shows its own install banner, so offer an
// explicit button whenever the browser says the app can be installed.
let installPrompt: BeforeInstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e as BeforeInstallPromptEvent;
  ui.install.hidden = false;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  ui.install.hidden = true;
});
ui.install.addEventListener('click', async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  ui.install.hidden = true;
  await prompt.prompt();
  await prompt.userChoice;
});

if (!isWebBluetoothAvailable()) {
  ui.connect.disabled = true;
  showNotice(
    'Web Bluetooth is not available in this browser. Use Chrome or Edge (desktop or Android) on https or ' +
      'localhost; on Linux you may need chrome://flags/#enable-experimental-web-platform-features. ' +
      'Downloaded files and "Open file" still work.',
    false,
    'notice.noBluetooth',
  );
}
updateConnectionUi();
void refreshLibrary();
// Ask the browser not to evict cached downloads under storage pressure;
// Chrome grants this to installed apps.
void navigator.storage?.persist?.().catch(() => {});
