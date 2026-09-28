import { describe, expect, it } from 'vitest';
import { normalizeTime, validateLabel, type TrackLabel } from '../src/labels/schema';

const label = (): TrackLabel => ({
  schema: 1,
  sha256: 'a'.repeat(64),
  source: 'fly2/26-09-26/13-34-06/TRACK.CSV',
  status: 'labelled',
  jumps: [
    {
      platform: 'aircraft',
      discipline: 'wingsuit',
      exit: { t: '2026-09-26T13:58:36.700Z' },
      deploy: { t: '2026-09-26T14:01:12.300Z' },
      open: { t: '2026-09-26T14:01:16.100Z', unsure: true },
      landing: { t: '2026-09-26T14:05:00.200Z' },
      flags: [],
      note: '',
    },
  ],
  flags: [],
  note: '',
});

describe('label schema', () => {
  it('accepts a valid label', () => {
    expect(validateLabel(label())).toEqual([]);
  });

  it('accepts a file without jumps and markers missing from the recording', () => {
    const noJump = { ...label(), jumps: [] };
    expect(validateLabel(noJump)).toEqual([]);
    const l = label();
    l.jumps[0].landing = null;
    expect(validateLabel(l)).toEqual([]);
  });

  it('rejects markers out of order', () => {
    const l = label();
    l.jumps[0].open = { t: '2026-09-26T14:01:12.300Z' };
    expect(validateLabel(l)).toEqual(['jumps[0].open: not after the previous marker']);
  });

  it('rejects overlapping jumps', () => {
    const l = label();
    l.jumps.push({ ...l.jumps[0] });
    expect(validateLabel(l)).toEqual(['jumps[1]: overlaps the previous jump']);
  });

  it('rejects bad values', () => {
    const l = { ...label(), sha256: 'xyz', status: 'done', flags: ['cutaway'] };
    l.jumps[0].exit = { t: '2026-09-26T13:58:36.7Z' };
    expect(validateLabel(l)).toEqual([
      'sha256: expected 64 lowercase hex digits',
      'status: expected one of unreviewed, labelled, skip',
      'flags[0]: expected one of bad-gps',
      'jumps[0].exit: expected null or { t: ISO timestamp with milliseconds }',
    ]);
  });

  it('normalises FlySight 1 centisecond timestamps', () => {
    expect(normalizeTime('2026-05-08T08:18:48.10Z')).toBe('2026-05-08T08:18:48.100Z');
    expect(normalizeTime('2025-09-21T06:58:48.202Z')).toBe('2025-09-21T06:58:48.202Z');
  });
});
