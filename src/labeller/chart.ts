/**
 * Minimal canvas time-series chart for the labeller: series on a left and a
 * right axis, vertical marker lines, shaded spans and a brush. Long ranges
 * are drawn as a min/max band per pixel column, so hours of 10 Hz data stay
 * fast; short ranges show a dot per sample.
 */

export interface Series {
  t: Float64Array;
  v: Float64Array;
  color: string;
  axis: 'left' | 'right';
  width?: number;
}

export interface VLine {
  t: number;
  color: string;
  width?: number;
  dash?: number[];
  label?: string;
}

export interface Span {
  t0: number;
  t1: number;
  color: string;
}

export interface Axis {
  min: number;
  max: number;
  unit: string;
}

/** Samples further apart than this are drawn with a break in the line. */
const GAP_S = 2;

export class Chart {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  t0 = 0;
  t1 = 1;
  series: Series[] = [];
  lines: VLine[] = [];
  spans: Span[] = [];
  left: Axis | null = null;
  right: Axis | null = null;
  brush: { t0: number; t1: number } | null = null;
  /** Horizontal line on the right axis (e.g. 1 g). */
  rightRef: number | null = null;
  title = '';
  /** Always mark each sample with a dot, not only when zoomed in far. */
  dots = false;
  readonly pad = { l: 40, r: 40, t: 16, b: 18 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  get plotWidth(): number {
    return Math.max(1, this.width - this.pad.l - this.pad.r);
  }

  get plotHeight(): number {
    return Math.max(1, this.height - this.pad.t - this.pad.b);
  }

  xOf(t: number): number {
    return this.pad.l + ((t - this.t0) / (this.t1 - this.t0)) * this.plotWidth;
  }

  tOf(x: number): number {
    return this.t0 + ((x - this.pad.l) / this.plotWidth) * (this.t1 - this.t0);
  }

  private yOf(v: number, axis: Axis): number {
    return this.pad.t + (1 - (v - axis.min) / (axis.max - axis.min || 1)) * this.plotHeight;
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw(): void {
    const { ctx, pad } = this;
    const css = getComputedStyle(this.canvas);
    const fg = css.getPropertyValue('--chart-fg') || '#444';
    const grid = css.getPropertyValue('--chart-grid') || '#e4e4e4';
    ctx.clearRect(0, 0, this.width, this.height);
    if (this.width < 10 || this.t1 <= this.t0) return;
    ctx.font = '10px system-ui, sans-serif';

    for (const s of this.spans) {
      const x0 = Math.max(pad.l, this.xOf(s.t0));
      const x1 = Math.min(pad.l + this.plotWidth, this.xOf(s.t1));
      if (x1 <= x0) continue;
      ctx.fillStyle = s.color;
      ctx.fillRect(x0, pad.t, x1 - x0, this.plotHeight);
    }

    // Grid and axes.
    ctx.strokeStyle = grid;
    ctx.fillStyle = fg;
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tStep = niceStep((this.t1 - this.t0) / Math.max(2, this.plotWidth / 90), TIME_STEPS);
    for (let t = Math.ceil(this.t0 / tStep) * tStep; t <= this.t1; t += tStep) {
      const x = Math.round(this.xOf(t)) + 0.5;
      line(ctx, x, pad.t, x, pad.t + this.plotHeight);
      ctx.fillText(formatTime(t, tStep), x, pad.t + this.plotHeight + 4);
    }
    if (this.left) this.drawAxis(this.left, 'left', grid, fg);
    if (this.right) this.drawAxis(this.right, 'right', null, fg);
    if (this.right && this.rightRef !== null) {
      ctx.strokeStyle = fg;
      ctx.setLineDash([2, 3]);
      const y = Math.round(this.yOf(this.rightRef, this.right)) + 0.5;
      line(ctx, pad.l, y, pad.l + this.plotWidth, y);
      ctx.setLineDash([]);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, this.plotWidth, this.plotHeight);
    ctx.clip();
    for (const s of this.series) {
      const axis = s.axis === 'left' ? this.left : this.right;
      if (axis) this.drawSeries(s, axis);
    }
    ctx.restore();

    if (this.brush) {
      const x0 = this.xOf(this.brush.t0);
      const x1 = this.xOf(this.brush.t1);
      ctx.fillStyle = 'rgba(11, 107, 203, 0.12)';
      ctx.strokeStyle = 'rgba(11, 107, 203, 0.8)';
      ctx.fillRect(x0, pad.t, x1 - x0, this.plotHeight);
      ctx.strokeRect(Math.round(x0) + 0.5, pad.t + 0.5, Math.round(x1 - x0), this.plotHeight - 1);
    }

    ctx.textBaseline = 'top';
    for (const l of this.lines) {
      const x = Math.round(this.xOf(l.t)) + 0.5;
      if (x < pad.l - 1 || x > pad.l + this.plotWidth + 1) continue;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.width ?? 1;
      ctx.setLineDash(l.dash ?? []);
      line(ctx, x, pad.t, x, pad.t + this.plotHeight);
      ctx.setLineDash([]);
      if (l.label) {
        ctx.fillStyle = l.color;
        ctx.fillText(l.label, x, 2);
      }
    }
    ctx.lineWidth = 1;

    if (this.title) {
      ctx.fillStyle = fg;
      ctx.textAlign = 'left';
      ctx.fillText(this.title, pad.l + 4, pad.t + 2);
    }
  }

  private drawAxis(axis: Axis, side: 'left' | 'right', grid: string | null, fg: string): void {
    const { ctx, pad } = this;
    const step = niceStep((axis.max - axis.min) / Math.max(2, this.plotHeight / 40), VALUE_STEPS);
    ctx.textAlign = side === 'left' ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    const x = side === 'left' ? pad.l - 4 : pad.l + this.plotWidth + 4;
    for (let v = Math.ceil(axis.min / step) * step; v <= axis.max; v += step) {
      const y = Math.round(this.yOf(v, axis)) + 0.5;
      if (grid) {
        ctx.strokeStyle = grid;
        line(ctx, pad.l, y, pad.l + this.plotWidth, y);
      }
      ctx.fillStyle = fg;
      ctx.fillText(formatValue(v, step), x, y);
    }
    ctx.textBaseline = 'bottom';
    ctx.fillText(axis.unit, x, pad.t - 2);
  }

  private drawSeries(s: Series, axis: Axis): void {
    const { ctx } = this;
    const t = s.t;
    const i0 = Math.max(0, lowerBound(t, this.t0) - 1);
    const i1 = Math.min(t.length - 1, lowerBound(t, this.t1));
    if (i1 <= i0) return;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width ?? 1.2;
    ctx.beginPath();
    const count = i1 - i0 + 1;
    if (count > this.plotWidth * 2) {
      // One vertical min–max segment per pixel column.
      let col = -1;
      let lo = Infinity;
      let hi = -Infinity;
      const flush = () => {
        if (col < 0 || lo > hi) return;
        ctx.moveTo(col + 0.5, this.yOf(hi, axis));
        ctx.lineTo(col + 0.5, this.yOf(lo, axis) + 0.5);
      };
      for (let i = i0; i <= i1; i++) {
        const c = Math.floor(this.xOf(t[i]));
        if (c !== col) {
          flush();
          col = c;
          lo = Infinity;
          hi = -Infinity;
        }
        const v = s.v[i];
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      flush();
      ctx.stroke();
      return;
    }
    let pen = false;
    for (let i = i0; i <= i1; i++) {
      const v = s.v[i];
      if (!Number.isFinite(v)) {
        pen = false;
        continue;
      }
      const x = this.xOf(t[i]);
      const y = this.yOf(v, axis);
      if (pen && t[i] - t[i - 1] <= GAP_S) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
    if (this.dots || count < this.plotWidth / 4) {
      const r = count < this.plotWidth / 4 ? 1.5 : 1;
      for (let i = i0; i <= i1; i++) {
        if (!Number.isFinite(s.v[i])) continue;
        ctx.fillRect(this.xOf(t[i]) - r, this.yOf(s.v[i], axis) - r, 2 * r, 2 * r);
      }
    }
  }
}

/** Axis covering the values of the given series within [t0, t1]. */
export function fitAxis(series: Series[], t0: number, t1: number, unit: string, includeZero = true): Axis {
  let min = includeZero ? 0 : Infinity;
  let max = includeZero ? 0 : -Infinity;
  for (const s of series) {
    const i0 = lowerBound(s.t, t0);
    const i1 = Math.min(s.t.length - 1, lowerBound(s.t, t1));
    for (let i = i0; i <= i1; i++) {
      const v = s.v[i];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, unit };
  const span = max - min || 1;
  return { min: min - span * 0.04, max: max + span * 0.04, unit };
}

export function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const TIME_STEPS = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const VALUE_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

function niceStep(raw: number, steps: number[]): number {
  return steps.find((s) => s >= raw) ?? steps[steps.length - 1];
}

function formatTime(t: number, step: number): string {
  const iso = new Date(Math.round(t * 1000)).toISOString();
  return step < 1 ? iso.slice(14, 21) : step < 60 ? iso.slice(11, 19) : iso.slice(11, 16);
}

function formatValue(v: number, step: number): string {
  return step < 1 ? v.toFixed(1) : String(Math.round(v));
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}
