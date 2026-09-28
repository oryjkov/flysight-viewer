/**
 * Jump view: the classifier finds the jumps in a track, and each is shown
 * from exit to landing — header, stat tiles, drop vs distance flown, velocity polar
 * and time charts, with a shared hover cursor.
 */
import { segment } from '../classify/segment';
import { derive, isoTime, type Track } from '../track/track';
import { h } from '../ui/dom';
import { analyzeJump, type Jump } from './analyze';
import { niceMax, Plot, type PlotLine, type PlotMark, type PlotRef } from './plot';

/** Speed unit; lengths are always metres. */
type UnitSystem = 'kmh' | 'ms';

const UNITS: Record<UnitSystem, { speed: number; speedUnit: string; length: number; lengthUnit: string }> = {
  kmh: { speed: 3.6, speedUnit: 'km/h', length: 1, lengthUnit: 'm' },
  ms: { speed: 1, speedUnit: 'm/s', length: 1, lengthUnit: 'm' },
};

/**
 * Speed colour scale for the drop profile: dark blue when slow, through
 * cyan, yellow and orange, to red at RAMP_MAX and above.
 */
const SPEED_STOPS: [number, [number, number, number]][] = [
  [0, [0, 0, 160]],
  [0.12, [0, 40, 255]],
  [0.25, [0, 210, 255]],
  [0.38, [40, 255, 150]],
  [0.5, [255, 240, 0]],
  [0.75, [255, 130, 0]],
  [1, [255, 20, 0]],
];
/** Colour steps: enough to look continuous, few enough to batch line segments. */
const SPEED_STEPS = 64;
/** Top of the speed colour scale, m/s (200 km/h). */
const RAMP_MAX = 200 / 3.6;
const PROFILE_DEFAULT = 800;

export function jumpView(track: Track): HTMLElement {
  const d = derive(track);
  const jumps = segment(track).map((label) => analyzeJump(track, label, d));
  if (!jumps.length) {
    return h('div', { class: 'jump-empty' }, 'No jump found in this track.');
  }

  const root = h('div', { class: 'jump-view' });
  const state = {
    jump: 0,
    units: loadUnits(),
    seaLevel: loadFlag('jump.seaLevel'),
    cropAtDeploy: true,
    profileRange: PROFILE_DEFAULT,
    hover: null as number | null,
  };

  // ------------------------------------------------------------ skeleton

  const head = h('div', { class: 'jump-head' });
  const tiles = h('div', { class: 'tiles' });
  const unitsButton = h('button', { class: 'units', title: 'Switch between km/h and m/s' });
  const densityButton = h(
    'button',
    {
      class: 'density',
      title:
        'Show speeds adjusted to sea-level air density (standard atmosphere): the speed with the same drag at sea level. ' +
        'Glide ratio, heights and distances are unchanged; horizontal speeds still include wind.',
    },
    'Sea-level speeds',
  );
  const tabs = h('div', { class: 'jump-tabs' });

  const profileCanvas = h('canvas', { class: 'plot plot-square' });
  const rangeInput = h('input', { type: 'range', min: '100', max: '3000', step: '50' });
  const rangeValue = h('span', { class: 'range-value' });
  const speedLegend = h('span', { class: 'ramp-legend' });
  const polarCanvas = h('canvas', { class: 'plot plot-square' });
  const timeCanvas = h('canvas', { class: 'plot plot-time' });
  const timeLegend = h('span', { class: 'legend' });
  const cropInput = h('input', { type: 'checkbox', checked: true });
  const tooltip = h('div', { class: 'jump-tooltip', hidden: true });

  root.append(
    head,
    h('div', { class: 'jump-bar' }, tiles, h('div', { class: 'jump-bar-right' }, tabs, densityButton, unitsButton)),
    h(
      'div',
      { class: 'jump-charts' },
      h(
        'section',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('h4', {}, 'Drop vs distance flown'),
          h('label', { class: 'range', title: 'Height of the profile from exit' }, rangeInput, rangeValue),
          speedLegend,
        ),
        profileCanvas,
      ),
      h(
        'section',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('h4', {}, 'Velocity polar'),
          h(
            'span',
            { class: 'legend' },
            swatch('--series-1'),
            'freefall',
            swatch('--series-2'),
            'canopy',
            h('i', { class: 'ring' }),
            'deploy',
          ),
        ),
        polarCanvas,
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h4', {}, 'Time chart'),
        timeLegend,
        h('label', { class: 'crop' }, cropInput, ' Crop at deploy'),
      ),
      timeCanvas,
    ),
    tooltip,
  );

  const profile = new Plot(profileCanvas);
  profile.square = true;
  // The polar fills its card; the glide-ratio lines don't need equal scales.
  const polar = new Plot(polarCanvas);
  const timePlot = new Plot(timeCanvas);
  timePlot.pad.r = 48;

  // Time chart series, in legend order; clicking a legend entry hides it.
  const TIME_SERIES = [
    { key: 'elevation', name: 'elevation', color: '--chart-ink' },
    { key: 'glide', name: 'glide ratio', color: '--series-4' },
    { key: 'total', name: 'total speed', color: '--series-1' },
    { key: 'horizontal', name: 'horizontal', color: '--series-2' },
    { key: 'vertical', name: 'vertical', color: '--series-3' },
  ] as const;
  type TimeKey = (typeof TIME_SERIES)[number]['key'];
  const hidden = new Set<TimeKey>();
  timeLegend.append(
    ...TIME_SERIES.map(({ key, name, color }) => {
      const b = h('button', { class: 'legend-item', 'aria-pressed': 'true', title: `Show or hide ${name}` }, swatch(color), name);
      b.onclick = () => {
        if (hidden.has(key)) hidden.delete(key);
        else hidden.add(key);
        b.setAttribute('aria-pressed', String(!hidden.has(key)));
        renderPlots();
      };
      return b;
    }),
  );

  // ------------------------------------------------------------ rendering

  const jump = (): Jump => jumps[state.jump];
  /** Series index of the deploy marker, or the last index. */
  const deployK = (): number => {
    const j = jump();
    return (j.deploy ?? j.end) - j.start;
  };

  /** Speed multiplier at series index k: 1, or the sea-level factor when adjusting. */
  const factor = (k: number): number => (state.seaLevel ? jump().series.seaLevel[k] : 1);

  /** A speed series in display units, sea-level adjusted when the toggle is on. */
  function shown(a: Float64Array, u: (typeof UNITS)[UnitSystem]): Float64Array {
    return Float64Array.from(a, (v, k) => v * u.speed * factor(k));
  }

  /** Highest total speed from exit to deploy, m/s, as currently shown. */
  function maxSpeed(): number {
    const s = jump().series;
    let max = 0;
    for (let k = 0; k <= deployK(); k++) max = Math.max(max, s.speed[k] * factor(k));
    return max;
  }

  function renderHead(): void {
    const j = jump();
    const u = UNITS[state.units];
    const exitIndex = j.exit ?? j.start;
    const when = new Date(track.t[exitIndex] * 1000);
    const lat = track.lat[exitIndex].toFixed(6);
    const lon = track.lon[exitIndex].toFixed(6);
    const copy = h('button', { class: 'icon copy', title: 'Copy coordinates' }, '⧉');
    copy.onclick = () => void navigator.clipboard?.writeText(`${lat}, ${lon}`);
    head.replaceChildren(
      h('h3', { class: 'jump-title' }, isoTime(track, exitIndex)),
      h(
        'div',
        { class: 'jump-sub' },
        h('span', {}, when.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })),
        h(
          'span',
          {},
          j.stats.exitAlt !== null ? `Exit: ${len(j.stats.exitAlt, u)} ASL` : 'Exit not recorded',
        ),
        h('span', { class: 'coords' }, `${lat}, ${lon}`, copy),
        h('span', { class: 'chip' }, j.label.platform),
        h('span', { class: 'chip' }, j.label.discipline),
      ),
    );

    const s = j.stats;
    tiles.replaceChildren(
      tile('Exit', s.exitAgl !== null ? `${len(s.exitAgl, u)} AGL` : '—'),
      tile('Freefall', s.freefallTime !== null ? duration(s.freefallTime) : '—'),
      tile(state.seaLevel ? 'Max speed (sea level)' : 'Max speed', speed(maxSpeed(), u)),
      tile('Deploy alt', s.deployAgl !== null ? `${len(s.deployAgl, u)} AGL` : '—', true),
      tile('Canopy', s.canopyTime !== null ? duration(s.canopyTime) : '—'),
    );

    tabs.replaceChildren(
      ...(jumps.length > 1
        ? jumps.map((x, i) => {
            const b = h(
              'button',
              { 'aria-pressed': String(i === state.jump) },
              `Jump ${i + 1} · ${isoTime(track, x.exit ?? x.start).slice(11, 16)}`,
            );
            b.onclick = () => {
              state.jump = i;
              state.hover = null;
              render();
            };
            return b;
          })
        : []),
    );
    unitsButton.textContent = u.speedUnit;
    densityButton.setAttribute('aria-pressed', String(state.seaLevel));
    rangeValue.textContent = len(state.profileRange, u);
    rangeInput.value = String(state.profileRange);
    const gradient = SPEED_STOPS.map(([f]) => `${speedColor(f * RAMP_MAX)} ${f * 100}%`).join(', ');
    speedLegend.replaceChildren(
      h(
        'span',
        { class: 'ramp' },
        h('span', { class: 'ramp-bar', style: `background: linear-gradient(90deg, ${gradient})` }),
        h(
          'span',
          { class: 'ramp-ticks' },
          ...[0, 0.25, 0.5, 0.75, 1].map((f) =>
            h('span', {}, `${Math.round(f * RAMP_MAX * u.speed)}${f === 1 ? '+' : ''}`),
          ),
        ),
      ),
      u.speedUnit,
    );
  }

  function renderPlots(): void {
    const j = jump();
    const s = j.series;
    const u = UNITS[state.units];
    const c = colors(root);
    const n = s.t.length;
    const dk = deployK();
    const hover = state.hover;
    const scaled = (a: Float64Array, k: number) => Float64Array.from(a, (v) => v * k);
    const vH = shown(s.velH, u);
    const vD = shown(s.velD, u);
    const total = shown(s.speed, u);

    // Drop vs distance flown: freefall only, until the chosen height is lost.
    const range = state.profileRange * u.length;
    let last = 0;
    while (last < dk && s.drop[last + 1] <= state.profileRange * 1.02) last++;
    profile.x = { min: 0, max: range, title: `Horizontal distance flown (${u.lengthUnit})` };
    profile.y = { min: 0, max: range, title: `Vertical drop (${u.lengthUnit})`, invert: true };
    profile.refs = [{ x0: 0, y0: 0, x1: range, y1: range, label: '1:1' }];
    profile.lines = [
      {
        x: scaled(s.distance, u.length),
        y: scaled(s.drop, u.length),
        to: last,
        color: speedColor(0),
        colorAt: (i) => speedColor(s.speed[i] * factor(i)),
        width: 3,
      },
    ];
    profile.marks = [];
    if (j.deploy !== null && dk <= last) {
      profile.marks.push({ x: s.distance[dk] * u.length, y: s.drop[dk] * u.length, color: c.ink, ring: true });
    }
    if (hover !== null && hover <= last) {
      profile.marks.push({ x: s.distance[hover] * u.length, y: s.drop[hover] * u.length, color: c.ink });
    }
    profile.draw();

    // Velocity polar: freefall and canopy.
    let minVD = 0;
    let maxVD = 0;
    let maxVH = 0;
    for (let k = 0; k < n; k++) {
      minVD = Math.min(minVD, vD[k]);
      maxVD = Math.max(maxVD, vD[k]);
      maxVH = Math.max(maxVH, vH[k]);
    }
    const xMax = niceMax(maxVH, 10);
    polar.x = { min: 0, max: xMax, title: `Horizontal (${u.speedUnit}${state.seaLevel ? ', sea level' : ''})` };
    // Above 0 only as far as the jumper actually climbed (flares, aircraft).
    polar.y = {
      min: minVD < -0.5 ? -niceMax(-minVD) : 0,
      max: niceMax(maxVD, 10),
      title: `Vertical (${u.speedUnit}${state.seaLevel ? ', sea level' : ''})`,
      invert: true,
    };
    polar.refs = [1, 2, 3].map((k) => ({ x0: 0, y0: 0, x1: xMax, y1: xMax / k, label: `${k}:1` }));
    polar.lines = [
      { x: vH, y: vD, to: dk, color: c.series1 },
      { x: vH, y: vD, from: dk, color: c.series2 },
    ];
    polar.marks = [];
    if (j.deploy !== null) polar.marks.push({ x: vH[dk], y: vD[dk], color: c.ink, ring: true });
    if (hover !== null) polar.marks.push({ x: vH[hover], y: vD[hover], color: c.ink });
    polar.draw();

    // Time charts.
    const end = state.cropAtDeploy && j.deploy !== null ? dk : n - 1;
    const tMax = s.t[end];
    const inRange = (a: Float64Array) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k <= end; k++) {
        if (!Number.isFinite(a[k])) continue;
        lo = Math.min(lo, a[k]);
        hi = Math.max(hi, a[k]);
      }
      return [lo, hi];
    };
    const deployRef: PlotRef[] =
      j.deploy !== null && !state.cropAtDeploy ? [{ x0: s.t[dk], y0: -1e9, x1: s.t[dk], y1: 1e9 }] : [];
    const time = { min: 0, max: Math.max(1, tMax), title: 'Time from exit (s)' };

    // Speeds on the left axis, glide ratio on the right; elevation is scaled
    // to the chart's height (its values are in the tooltip).
    const [speedLo, speedHi] = [Math.min(0, inRange(vD)[0]), Math.max(inRange(total)[1], inRange(vH)[1])];
    const yMin = speedLo < 0 ? -niceMax(-speedLo, 5) : 0;
    const yMax = niceMax(speedHi, 10);
    const aglMax = Math.max(1, inRange(s.agl)[1]);
    const elevation = Float64Array.from(s.agl, (v) => yMin + (v / aglMax) * (yMax - yMin));
    timePlot.x = time;
    timePlot.y = { min: yMin, max: yMax, title: `Speed (${u.speedUnit}${state.seaLevel ? ', sea level' : ''})` };
    timePlot.y2 = { min: 0, max: 4, title: 'Glide ratio' };
    const lines: Record<TimeKey, PlotLine> = {
      elevation: { x: s.t, y: elevation, to: end, color: c.ink, width: 1.5 },
      glide: { x: s.t, y: s.glide, to: end, color: c.series4, right: true, width: 1.5 },
      total: { x: s.t, y: total, to: end, color: c.series1 },
      horizontal: { x: s.t, y: vH, to: end, color: c.series2 },
      vertical: { x: s.t, y: vD, to: end, color: c.series3 },
    };
    timePlot.lines = TIME_SERIES.filter(({ key }) => !hidden.has(key)).map(({ key }) => lines[key]);
    timePlot.refs = deployRef;
    timePlot.cursorX = hover !== null && hover <= end ? s.t[hover] : null;
    const marks: PlotMark[] = [];
    if (hover !== null && hover <= end) {
      for (const line of timePlot.lines) {
        const y = line.y[hover];
        if (Number.isFinite(y)) marks.push({ x: s.t[hover], y, color: line.color, right: line.right });
      }
    }
    timePlot.marks = marks;
    timePlot.draw();
  }

  function render(): void {
    renderHead();
    renderPlots();
  }

  // ------------------------------------------------------------ hover

  function showTooltip(k: number, e: PointerEvent): void {
    const j = jump();
    const s = j.series;
    const u = UNITS[state.units];
    const row = (color: string | null, name: string, value: string) =>
      h('div', { class: 'tt-row' }, color ? swatch(color) : h('i', { class: 'sw-none' }), h('span', {}, name), h('b', {}, value));
    tooltip.replaceChildren(
      h('div', { class: 'tt-title' }, `${s.t[k].toFixed(1)} s from exit`),
      row('--chart-ink', 'Elevation', `${len(s.agl[k], u)} AGL`),
      row('--series-4', 'Glide ratio', Number.isFinite(s.glide[k]) ? s.glide[k].toFixed(2) : '—'),
      row('--series-1', 'Total speed', speed(s.speed[k] * factor(k), u)),
      row('--series-2', 'Horizontal', speed(s.velH[k] * factor(k), u)),
      row('--series-3', 'Vertical', speed(s.velD[k] * factor(k), u)),
      row(null, 'Distance flown', len(s.distance[k], u)),
      row(null, 'From exit', len(s.fromExit[k], u)),
    );
    tooltip.hidden = false;
    const r = tooltip.getBoundingClientRect();
    const x = e.clientX + 16 + r.width > innerWidth ? e.clientX - 16 - r.width : e.clientX + 16;
    const y = Math.min(e.clientY + 16, innerHeight - r.height - 8);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }

  function setHover(k: number | null, e?: PointerEvent): void {
    state.hover = k;
    renderPlots();
    if (k === null || !e) tooltip.hidden = true;
    else showTooltip(k, e);
  }

  /** Nearest series index to the pointer among the given lines, within `radius` px. */
  function nearest(p: Plot, lines: PlotLine[], e: PointerEvent, radius = 30): number | null {
    const rect = p.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: number | null = null;
    let bestD = radius * radius;
    for (const line of lines) {
      const to = Math.min(line.x.length - 1, line.to ?? line.x.length - 1);
      for (let k = line.from ?? 0; k <= to; k++) {
        const dx = p.px(line.x[k]) - mx;
        const dy = p.py(line.y[k]) - my;
        const dist = dx * dx + dy * dy;
        if (dist < bestD) {
          bestD = dist;
          best = k;
        }
      }
    }
    return best;
  }

  for (const p of [timePlot]) {
    p.canvas.addEventListener('pointermove', (e) => {
      const s = jump().series;
      const t = p.xAt(e.clientX - p.canvas.getBoundingClientRect().left);
      const end = state.cropAtDeploy && jump().deploy !== null ? deployK() : s.t.length - 1;
      if (t < 0 || t > s.t[end]) return setHover(null);
      let k = 0;
      while (k < end && s.t[k + 1] <= t) k++;
      if (k < end && t - s.t[k] > s.t[k + 1] - t) k++;
      setHover(k, e);
    });
  }
  for (const p of [profile, polar]) {
    p.canvas.addEventListener('pointermove', (e) => setHover(nearest(p, p.lines, e), e));
  }
  for (const p of [profile, polar, timePlot]) p.canvas.addEventListener('pointerleave', () => setHover(null));

  // ------------------------------------------------------------ controls

  densityButton.onclick = () => {
    state.seaLevel = !state.seaLevel;
    saveFlag('jump.seaLevel', state.seaLevel);
    render();
  };
  unitsButton.onclick = () => {
    state.units = state.units === 'kmh' ? 'ms' : 'kmh';
    saveUnits(state.units);
    render();
  };
  rangeInput.oninput = () => {
    state.profileRange = Number(rangeInput.value);
    rangeValue.textContent = len(state.profileRange, UNITS[state.units]);
    renderPlots();
  };
  cropInput.onchange = () => {
    state.cropAtDeploy = cropInput.checked;
    renderPlots();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());

  // Charts size themselves once attached; draw after layout.
  requestAnimationFrame(() => render());
  render();
  return root;
}

// ---------------------------------------------------------------- helpers

function colors(el: HTMLElement): Record<'series1' | 'series2' | 'series3' | 'series4' | 'ink', string> {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    series1: v('--series-1'),
    series2: v('--series-2'),
    series3: v('--series-3'),
    series4: v('--series-4'),
    ink: v('--chart-ink'),
  };
}

/** Colour for a speed in m/s on the drop profile's scale. */
function speedColor(ms: number): string {
  const f = Math.round(Math.min(1, Math.max(0, ms / RAMP_MAX)) * SPEED_STEPS) / SPEED_STEPS;
  let k = 1;
  while (k < SPEED_STOPS.length - 1 && SPEED_STOPS[k][0] < f) k++;
  const [f0, c0] = SPEED_STOPS[k - 1];
  const [f1, c1] = SPEED_STOPS[k];
  const w = (f - f0) / (f1 - f0);
  const [r, g, b] = c0.map((c, i) => Math.round(c + (c1[i] - c) * w));
  return `rgb(${r}, ${g}, ${b})`;
}

function swatch(variable: string): HTMLElement {
  return h('i', { class: 'sw', style: `background: var(${variable})` });
}

function tile(label: string, value: string, ring = false): HTMLElement {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, ring && h('i', { class: 'ring' }), label), h('div', { class: 'tile-value' }, value));
}

function len(m: number, u: (typeof UNITS)[UnitSystem]): string {
  return `${Math.round(m * u.length)} ${u.lengthUnit}`;
}

function speed(ms: number, u: (typeof UNITS)[UnitSystem]): string {
  return `${Math.round(ms * u.speed)} ${u.speedUnit}`;
}

function duration(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${Math.round(s)} s`;
}

function loadUnits(): UnitSystem {
  try {
    return localStorage.getItem('jump.units') === 'ms' ? 'ms' : 'kmh';
  } catch {
    return 'kmh';
  }
}

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'on';
  } catch {
    return false;
  }
}

function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? 'on' : 'off');
  } catch {
    // Not remembered; applies to this view.
  }
}

function saveUnits(units: UnitSystem): void {
  try {
    localStorage.setItem('jump.units', units);
  } catch {
    // Not remembered; applies to this view.
  }
}
