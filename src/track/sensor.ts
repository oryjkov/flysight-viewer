/**
 * Accelerometer data from a FlySight 2 SENSOR.CSV, on the same clock as the
 * GNSS track.
 *
 * Sensor rows are timestamped in seconds since power-on. $TIME rows pair that
 * clock with a time of week and week number about once a second once the
 * receiver has a fix; the median offset over all of them maps sensor time to
 * the track's clock. The time of week is on the same scale as the track's UTC
 * timestamps — no GPS−UTC leap-second correction: with it, sensor logs would
 * end 18 s before the track logs they were recorded with.
 */
import { column, parseFlysightCsv } from '../parse/flysight';

/** 1980-01-06T00:00:00Z, the GPS epoch, in Unix seconds. */
const GPS_EPOCH = 315964800;

export interface SensorData {
  /** Unix seconds. */
  t: Float64Array;
  /** Magnitude of the accelerometer reading (specific force), g. */
  force: Float64Array;
}

/** Returns null when the file has no IMU rows or no GPS time to align them. */
export function parseSensor(bytes: Uint8Array): SensorData | null {
  const log = parseFlysightCsv(bytes);
  const imu = log.tables.get('IMU');
  const time = log.tables.get('TIME');
  if (!imu || !time || imu.rows === 0 || time.rows === 0) return null;

  const offset = clockOffset(column(time, 'time')!, column(time, 'tow')!, column(time, 'week')!);
  if (offset === null) return null;

  const it = column(imu, 'time')!;
  const ax = column(imu, 'ax')!;
  const ay = column(imu, 'ay')!;
  const az = column(imu, 'az')!;
  const t = new Float64Array(imu.rows);
  const force = new Float64Array(imu.rows);
  for (let i = 0; i < imu.rows; i++) {
    t[i] = it[i] + offset;
    force[i] = Math.hypot(ax[i], ay[i], az[i]);
  }
  return { t, force };
}

/** Seconds to add to sensor time to get Unix time, or null without data. */
export function clockOffset(time: number[], tow: number[], week: number[]): number | null {
  const offsets: number[] = [];
  for (let i = 0; i < time.length; i++) {
    const utc = GPS_EPOCH + week[i] * 604800 + tow[i];
    const o = utc - time[i];
    if (Number.isFinite(o) && week[i] > 0) offsets.push(o);
  }
  if (offsets.length === 0) return null;
  offsets.sort((a, b) => a - b);
  return offsets[offsets.length >> 1];
}
