export const ATTR_READ_ONLY = 0x01;
export const ATTR_HIDDEN = 0x02;
export const ATTR_SYSTEM = 0x04;
export const ATTR_DIRECTORY = 0x10;
export const ATTR_ARCHIVE = 0x20;

/**
 * Decode a FAT date/time pair to "YYYY-MM-DD HH:MM:SS".
 *
 * The FlySight stamps files from its RTC; there is no time zone attached, so
 * this stays a plain string rather than pretending to be a Date.
 */
export function formatFatDateTime(fdate: number, ftime: number): string | null {
  if (fdate === 0) return null;
  const year = 1980 + (fdate >> 9);
  const month = (fdate >> 5) & 0x0f;
  const day = fdate & 0x1f;
  const hour = ftime >> 11;
  const min = (ftime >> 5) & 0x3f;
  const sec = (ftime & 0x1f) * 2;
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(min)}:${pad(sec)}`;
}

export function encodeFatDateTime(d: Date): { fdate: number; ftime: number } {
  return {
    fdate: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    ftime: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
