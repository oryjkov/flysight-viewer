/**
 * Downloaded files, cached in IndexedDB so they survive reloads and can be
 * opened without the device. Metadata and contents live in separate stores so
 * listing the library does not load every file into memory.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface StoredFileMeta {
  /** `${deviceId}|${path}` */
  key: string;
  deviceId: string;
  deviceName: string;
  path: string;
  size: number;
  /** FAT timestamp from the device listing. */
  modified: string | null;
  downloadedAt: number;
}

interface Schema extends DBSchema {
  meta: { key: string; value: StoredFileMeta };
  blobs: { key: string; value: Uint8Array };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

function db(): Promise<IDBPDatabase<Schema>> {
  dbPromise ??= openDB<Schema>('flysight-viewer', 1, {
    upgrade(db) {
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('blobs');
    },
  });
  return dbPromise;
}

export function fileKey(deviceId: string, path: string): string {
  return `${deviceId}|${path}`;
}

export async function saveFile(meta: Omit<StoredFileMeta, 'key'>, data: Uint8Array): Promise<StoredFileMeta> {
  const full = { ...meta, key: fileKey(meta.deviceId, meta.path) };
  const tx = (await db()).transaction(['meta', 'blobs'], 'readwrite');
  await Promise.all([tx.objectStore('meta').put(full), tx.objectStore('blobs').put(data, full.key), tx.done]);
  return full;
}

export async function listFiles(): Promise<StoredFileMeta[]> {
  const all = await (await db()).getAll('meta');
  return all.sort((a, b) => b.downloadedAt - a.downloadedAt);
}

export async function loadFile(key: string): Promise<Uint8Array | undefined> {
  return (await db()).get('blobs', key);
}

export async function deleteFile(key: string): Promise<void> {
  const tx = (await db()).transaction(['meta', 'blobs'], 'readwrite');
  await Promise.all([tx.objectStore('meta').delete(key), tx.objectStore('blobs').delete(key), tx.done]);
}
