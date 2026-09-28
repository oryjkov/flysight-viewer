import './style.css';
import { CrsClient, type DirEntry } from './ble/crs';
import { FakeFlySight } from './ble/fakeDevice';
import type { Link } from './ble/link';
import { BleLink, isWebBluetoothAvailable } from './ble/transport';
import { fakeFsFromFiles } from './demo/folder';
import { ATTR_HIDDEN, ATTR_SYSTEM, joinPath, parentPath } from './fs/fat';
import { formatBytes, formatDuration, summarize, type Summary } from './parse/summary';
import * as store from './storage';
import { byId, fill, h } from './ui/dom';

interface Session {
  client: CrsClient;
  deviceId: string;
  deviceName: string;
}

const ui = {
  status: byId('status'),
  connect: byId<HTMLButtonElement>('connect'),
  simulate: byId<HTMLButtonElement>('simulate'),
  disconnect: byId<HTMLButtonElement>('disconnect'),
  folderInput: byId<HTMLInputElement>('folder-input'),
  notice: byId('notice'),
  refresh: byId<HTMLButtonElement>('refresh'),
  crumbs: byId('crumbs'),
  entries: byId('entries'),
  library: byId('library'),
  viewer: byId('viewer'),
};

let session: Session | null = null;
let cwd = '/';
let entries: DirEntry[] = [];
let listToken = 0;
let library: store.StoredFileMeta[] = [];
let transfer: AbortController | null = null;
let selectedKey: string | null = null;

// ---------------------------------------------------------------- connection

async function connectBle(): Promise<void> {
  clearNotice();
  setStatus('connecting', 'Choose your FlySight…');
  try {
    const link = await BleLink.request();
    setStatus('connecting', `Connecting to ${link.name}…`);
    await startSession(link);
  } catch (e) {
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

async function simulateFromFolder(files: FileList): Promise<void> {
  if (files.length === 0) return;
  clearNotice();
  session?.client.disconnect();
  const folder = files[0].webkitRelativePath.split('/')[0] || 'folder';
  // ~1 ms per packet is in the same range as a real BLE link
  const link = new FakeFlySight(fakeFsFromFiles(files), { name: `Simulated · ${folder}`, packetIntervalMs: 1 });
  try {
    await startSession(link);
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
  ui.simulate.hidden = connected;
  ui.disconnect.hidden = !connected;
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
  renderEntries();
  renderLibrary();

  const progress = renderTransfer(path, entry.size, () => controller.abort());
  const started = performance.now();
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
    transfer = null;
    renderEntries();
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

  fill(
    ui.viewer,
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

function showNotice(message: string, error = false): void {
  ui.notice.textContent = message;
  ui.notice.classList.toggle('error', error);
  ui.notice.hidden = false;
}

function clearNotice(): void {
  ui.notice.hidden = true;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

ui.connect.addEventListener('click', () => void connectBle());
ui.simulate.addEventListener('click', () => ui.folderInput.click());
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

if (!isWebBluetoothAvailable()) {
  ui.connect.disabled = true;
  showNotice(
    'Web Bluetooth is not available in this browser. Use Chrome or Edge (desktop or Android) on https or ' +
      'localhost; on Linux you may need chrome://flags/#enable-experimental-web-platform-features. ' +
      'Downloaded files and "Simulate from folder" still work.',
  );
}
void refreshLibrary();
