/** Minimal u-blox UBX frame scanner for RAW.UBX files. */

const NAMES: Record<string, string> = {
  '01-01': 'NAV-POSECEF',
  '01-02': 'NAV-POSLLH',
  '01-03': 'NAV-STATUS',
  '01-04': 'NAV-DOP',
  '01-07': 'NAV-PVT',
  '01-11': 'NAV-VELECEF',
  '01-12': 'NAV-VELNED',
  '01-20': 'NAV-TIMEGPS',
  '01-21': 'NAV-TIMEUTC',
  '01-35': 'NAV-SAT',
  '01-43': 'NAV-SIG',
  '02-13': 'RXM-SFRBX',
  '02-15': 'RXM-RAWX',
  '05-00': 'ACK-NAK',
  '05-01': 'ACK-ACK',
  '0a-04': 'MON-VER',
  '0a-08': 'MON-TXBUF',
  '0a-09': 'MON-HW',
  '0a-31': 'MON-SPAN',
  '0a-38': 'MON-RF',
  '0d-01': 'TIM-TP',
};

export interface UbxSummary {
  messages: { key: string; name: string; count: number; bytes: number }[];
  total: number;
  badChecksums: number;
  skippedBytes: number;
}

export function scanUbx(data: Uint8Array): UbxSummary {
  const counts = new Map<string, { count: number; bytes: number }>();
  let total = 0;
  let badChecksums = 0;
  let skippedBytes = 0;
  let i = 0;

  while (i + 8 <= data.length) {
    if (data[i] !== 0xb5 || data[i + 1] !== 0x62) {
      i++;
      skippedBytes++;
      continue;
    }
    const len = data[i + 4] | (data[i + 5] << 8);
    const end = i + 6 + len + 2;
    if (end > data.length) break;

    let a = 0;
    let b = 0;
    for (let j = i + 2; j < i + 6 + len; j++) {
      a = (a + data[j]) & 0xff;
      b = (b + a) & 0xff;
    }
    if (a !== data[end - 2] || b !== data[end - 1]) {
      badChecksums++;
      i++;
      skippedBytes++;
      continue;
    }

    const key = `${hex(data[i + 2])}-${hex(data[i + 3])}`;
    const entry = counts.get(key) ?? { count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += end - i;
    counts.set(key, entry);
    total++;
    i = end;
  }
  skippedBytes += data.length - i;

  const messages = [...counts]
    .map(([key, v]) => ({ key, name: NAMES[key] ?? `0x${key.replace('-', ' 0x')}`, ...v }))
    .sort((x, y) => y.count - x.count);
  return { messages, total, badChecksums, skippedBytes };
}

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}
