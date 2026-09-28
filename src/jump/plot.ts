/**
 * Small canvas XY plot for the jump view: linear axes, polylines (optionally
 * coloured per segment), dashed reference lines, ring markers and a hover
 * cursor. Colours come from CSS custom properties on the canvas, so light and
 * dark themes need no code.
 */

export interface PlotAxis {
  min: number;
  max: number;
  title: string;
  /** Draw max at the bottom (y) or left (x). */
  invert?: boolean;
  format?: (v: number) => string;
}

export interface PlotLine {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Index range to draw, inclusive. */
  from?: number;
  to?: number;
  color: string;
  /** Per-segment colour, overriding `color`. */
  colorAt?: (i: number) => string;
  width?: number;
}

export interface PlotRef {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  label?: string;
}

export interface PlotMark {
  x: number;
  y: number;
  color: string;
  /** Hollow ring (a named event) rather than a filled dot (the cursor). */
  ring?: boolean;
}

export class Plot {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  x: PlotAxis = { min: 0, max: 1, title: '' };
  y: PlotAxis = { min: 0, max: 1, title: '' };
  lines: PlotLine[] = [];
  refs: PlotRef[] = [];
  marks: PlotMark[] = [];
  /** Vertical cursor line at this x. */
  cursorX: number | null = null;
  /** Keep one data unit the same length on both axes. */
  square = false;
  readonly pad = { l: 52, r: 14, t: 10, b: 38 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());
  }

  /** Plot area in CSS pixels. */
  get area(): { l: number; t: number; w: number; h: number } {
    let w = Math.max(1, this.width - this.pad.l - this.pad.r);
    let h = Math.max(1, this.height - this.pad.t - this.pad.b);
    if (this.square) {
      const unitX = w / (this.x.max - this.x.min);
      const unitY = h / (this.y.max - this.y.min);
      if (unitX > unitY) w = unitY * (this.x.max - this.x.min);
      else h = unitX * (this.y.max - this.y.min);
    }
    return { l: this.pad.l, t: this.pad.t, w, h };
  }

  px(x: number): number {
    const a = this.area;
    const f = (x - this.x.min) / (this.x.max - this.x.min);
    return a.l + (this.x.invert ? 1 - f : f) * a.w;
  }

  py(y: number): number {
    const a = this.area;
    const f = (y - this.y.min) / (this.y.max - this.y.min);
    return a.t + (this.y.invert ? f : 1 - f) * a.h;
  }

  /** Data x at a CSS-pixel offset from the canvas' left edge. */
  xAt(px: number): number {
    const a = this.area;
    const f = (px - a.l) / a.w;
    return this.x.min + (this.x.invert ? 1 - f : f) * (this.x.max - this.x.min);
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
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);
    if (this.width < 20 || this.height < 20) return;
    const css = getComputedStyle(this.canvas);
    const ink = css.getPropertyValue('--chart-ink').trim() || '#52514e';
    const muted = css.getPropertyValue('--chart-muted').trim() || '#898781';
    const grid = css.getPropertyValue('--chart-grid').trim() || '#e1e0d9';
    const axis = css.getPropertyValue('--chart-axis').trim() || '#c3c2b7';
    const a = this.area;
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.lineWidth = 1;

    // Grid and tick labels.
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of ticks(this.x, a.w / 70)) {
      const x = Math.round(this.px(v)) + 0.5;
      stroke(ctx, grid, x, a.t, x, a.t + a.h);
      ctx.fillText(fmt(this.x, v), x, a.t + a.h + 5);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of ticks(this.y, a.h / 40)) {
      const y = Math.round(this.py(v)) + 0.5;
      stroke(ctx, grid, a.l, y, a.l + a.w, y);
      ctx.fillText(fmt(this.y, v), a.l - 6, y);
    }
    stroke(ctx, axis, a.l + 0.5, a.t, a.l + 0.5, a.t + a.h);
    stroke(ctx, axis, a.l, a.t + a.h - 0.5, a.l + a.w, a.t + a.h - 0.5);

    // Axis titles.
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(this.x.title, a.l + a.w / 2, Math.min(this.height - 2, a.t + a.h + this.pad.b - 2));
    ctx.save();
    ctx.translate(12, a.t + a.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText(this.y.title, 0, 0);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(a.l, a.t, a.w, a.h);
    ctx.clip();

    for (const r of this.refs) {
      ctx.setLineDash([4, 4]);
      stroke(ctx, muted, this.px(r.x0), this.py(r.y0), this.px(r.x1), this.py(r.y1));
      ctx.setLineDash([]);
      if (r.label) {
        ctx.fillStyle = muted;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(r.label, Math.min(this.px(r.x1), a.l + a.w) - 4, Math.min(this.py(r.y1), a.t + a.h) - 4);
      }
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const line of this.lines) this.drawLine(line);

    if (this.cursorX !== null) {
      const x = Math.round(this.px(this.cursorX)) + 0.5;
      stroke(ctx, ink, x, a.t, x, a.t + a.h);
    }
    ctx.restore();

    // Markers sit above everything, with a surface-coloured ring to separate them.
    const surface = css.getPropertyValue('--chart-surface').trim() || '#fff';
    for (const m of this.marks) {
      const x = this.px(m.x);
      const y = this.py(m.y);
      if (x < a.l - 1 || x > a.l + a.w + 1 || y < a.t - 1 || y > a.t + a.h + 1) continue;
      ctx.beginPath();
      ctx.arc(x, y, m.ring ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = surface;
      ctx.lineWidth = m.ring ? 5 : 4;
      ctx.strokeStyle = surface;
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = m.color;
      if (m.ring) ctx.stroke();
      else {
        ctx.fillStyle = m.color;
        ctx.fill();
      }
    }
    ctx.lineWidth = 1;
  }

  private drawLine(line: PlotLine): void {
    const { ctx } = this;
    const from = Math.max(0, line.from ?? 0);
    const to = Math.min(line.x.length - 1, line.to ?? line.x.length - 1);
    ctx.lineWidth = line.width ?? 2;
    if (line.colorAt) {
      // One path per run of equal colour keeps this fast.
      let color = '';
      let open = false;
      for (let i = from; i < to; i++) {
        const c = line.colorAt(i);
        if (!Number.isFinite(line.y[i]) || !Number.isFinite(line.y[i + 1])) continue;
        if (c !== color || !open) {
          if (open) ctx.stroke();
          color = c;
          ctx.strokeStyle = c;
          ctx.beginPath();
          ctx.moveTo(this.px(line.x[i]), this.py(line.y[i]));
          open = true;
        }
        ctx.lineTo(this.px(line.x[i + 1]), this.py(line.y[i + 1]));
      }
      if (open) ctx.stroke();
      return;
    }
    ctx.strokeStyle = line.color;
    ctx.beginPath();
    let pen = false;
    for (let i = from; i <= to; i++) {
      const y = line.y[i];
      if (!Number.isFinite(y)) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(this.px(line.x[i]), this.py(y));
      else ctx.moveTo(this.px(line.x[i]), this.py(y));
      pen = true;
    }
    ctx.stroke();
  }
}

/** Round axis end up to a tick step, for data that starts at 0. */
export function niceMax(v: number, minimum = 1): number {
  const max = Math.max(v, minimum);
  const step = niceStep(max / 5);
  return Math.ceil(max / step) * step;
}

function ticks(axis: PlotAxis, count: number): number[] {
  const step = niceStep((axis.max - axis.min) / Math.max(2, count));
  const out: number[] = [];
  for (let v = Math.ceil(axis.min / step) * step; v <= axis.max + step * 1e-9; v += step) out.push(v);
  return out;
}

function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

function fmt(axis: PlotAxis, v: number): string {
  if (axis.format) return axis.format(v);
  return Math.abs(v) < 10 && v % 1 !== 0 ? v.toFixed(1) : String(Math.round(v));
}

function stroke(ctx: CanvasRenderingContext2D, color: string, x0: number, y0: number, x1: number, y1: number): void {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}
