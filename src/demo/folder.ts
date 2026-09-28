import { FakeFs } from '../ble/fakeDevice';

/**
 * Build a simulated FlySight file system from a folder picked with
 * <input type="file" webkitdirectory>, e.g. a copy of the device's SD card.
 */
export function fakeFsFromFiles(files: Iterable<File>): FakeFs {
  const fs = new FakeFs();
  for (const file of files) {
    // webkitRelativePath is "<picked folder>/<path inside it>"
    const rel = file.webkitRelativePath.split('/').slice(1).join('/');
    if (!rel) continue;
    fs.addFile(
      rel,
      { size: file.size, load: async () => new Uint8Array(await file.arrayBuffer()) },
      new Date(file.lastModified),
    );
  }
  return fs;
}
