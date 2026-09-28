/**
 * Parser for FlySight 2 CSV logs (TRACK.CSV, SENSOR.CSV, EVENT.CSV).
 *
 * Format, as written by flysight-2-firmware FlySight/log.c:
 *
 *   $FLYS,1
 *   $VAR,FIRMWARE_VER,v2024.05.25
 *   $VAR,DEVICE_ID,...
 *   $COL,GNSS,time,lat,lon,hMSL,...
 *   $UNIT,GNSS,,deg,deg,m,...
 *   $DATA
 *   $GNSS,2025-09-28T14:03:22.200Z,43.1234567,...
 *
 * One file can hold several record types (SENSOR.CSV interleaves BARO, IMU,
 * ...), each with its own columns.
 */

export interface FlysightTable {
  type: string;
  columns: string[];
  units: string[];
  /**
   * Column-major data. Numeric columns are numbers (NaN when a cell does not
   * parse). GNSS "time" is an ISO timestamp and is stored as Unix seconds.
   */
  data: number[][];
  /** EVNT descriptions and any other free-text column. */
  text: Map<string, string[]>;
  rows: number;
}

export interface FlysightLog {
  format: string | null;
  vars: Map<string, string>;
  tables: Map<string, FlysightTable>;
  /** Lines that could not be attributed to a declared record type. */
  unknownLines: number;
}

const TEXT_COLUMNS: Record<string, string[]> = { EVNT: ['description'] };

export function isFlysightCsv(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '$FLYS';
}

export function parseFlysightCsv(bytes: Uint8Array): FlysightLog {
  const text = new TextDecoder('latin1').decode(bytes);
  const log: FlysightLog = { format: null, vars: new Map(), tables: new Map(), unknownLines: 0 };

  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    let line = text.slice(start, end);
    start = end + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    if (line[0] !== '$') {
      log.unknownLines++;
      continue;
    }

    const comma = line.indexOf(',');
    const tag = comma < 0 ? line.slice(1) : line.slice(1, comma);
    const rest = comma < 0 ? '' : line.slice(comma + 1);

    switch (tag) {
      case 'FLYS':
        log.format = rest;
        break;
      case 'VAR': {
        const i = rest.indexOf(',');
        if (i >= 0) log.vars.set(rest.slice(0, i), rest.slice(i + 1));
        break;
      }
      case 'COL': {
        const [type, ...columns] = rest.split(',');
        log.tables.set(type, newTable(type, columns));
        break;
      }
      case 'UNIT': {
        const [type, ...units] = rest.split(',');
        const table = log.tables.get(type);
        if (table) table.units = units;
        break;
      }
      case 'DATA':
        break;
      default: {
        const table = log.tables.get(tag);
        if (table) addRow(table, rest);
        else log.unknownLines++;
      }
    }
  }
  return log;
}

function newTable(type: string, columns: string[]): FlysightTable {
  const textColumns = TEXT_COLUMNS[type] ?? [];
  const text = new Map<string, string[]>();
  for (const c of textColumns) text.set(c, []);
  return {
    type,
    columns,
    units: columns.map(() => ''),
    data: columns.map(() => []),
    text,
    rows: 0,
  };
}

function addRow(table: FlysightTable, rest: string): void {
  const { columns } = table;
  let pos = 0;
  for (let c = 0; c < columns.length; c++) {
    const textCol = table.text.get(columns[c]);
    let cell: string;
    if (textCol && c === columns.length - 1) {
      // Free text is last and may contain commas: take the remainder
      cell = rest.slice(pos);
      pos = rest.length;
    } else {
      let next = rest.indexOf(',', pos);
      if (next < 0) next = rest.length;
      cell = rest.slice(pos, next);
      pos = next + 1;
    }
    if (textCol) {
      textCol.push(unquote(cell));
      table.data[c].push(NaN);
    } else {
      table.data[c].push(parseCell(cell));
    }
  }
  table.rows++;
}

function parseCell(cell: string): number {
  if (cell.length > 10 && cell[4] === '-' && cell.includes('T')) return Date.parse(cell) / 1000;
  return cell === '' ? NaN : Number(cell);
}

function unquote(s: string): string {
  return s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s;
}

export function column(table: FlysightTable, name: string): number[] | undefined {
  const i = table.columns.indexOf(name);
  return i < 0 ? undefined : table.data[i];
}
