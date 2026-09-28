/**
 * Jump view: the classifier finds the jumps in a track, and each is shown
 * from exit to landing — header, stat tiles, start profile, velocity polar
 * and time charts, with a shared hover cursor.
 */
import { segment } from '../classify/segment';
import { derive, isoTime, type Track } from '../track/track';
import { h } from '../ui/dom';
import { analyzeJump, type Jump } from './analyze';
import { niceMax, Plot, type PlotLine, type PlotMark, type PlotRef } from './plot';

type UnitSystem = 'metric' | 'imperial';

const UNITS: Record<UnitSystem, { speed: number; speedUnit: string; length: number; lengthUnit: string }> = {
  metric: { speed: 3.6, speedUnit: 'km/h', length: 1, lengthUnit: 'm' },
  imperial: { speed: 2.2369363, speedUnit: 'mph', length: 3.2808399, lengthUnit: 'ft' },
};

/** Sequential speed ramp (single hue), slowest first, per theme. */
const RAMP = {
  light: ['#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'],
  dark: ['#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#cde2fb'],
};
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
    cropAtDeploy: true,
    profileRange: PROFILE_DEFAULT,
    hover: null as number | null,
  };

  // ------------------------------------------------------------ skeleton

  const head = h('div', { class: 'jump-head' });
  const tiles = h('div', { class: 'tiles' });
  const unitsButton = h('button', { class: 'units', title: 'Switch units' });
  const tabs = h('div', { class: 'jump-tabs' });

  const profileCanvas = h('canvas', { class: 'plot plot-square' });
  const rangeInput = h('input', { type: 'range', min: '100', max: '3000', step: '50' });
  const rangeValue = h('span', { class: 'range-value' });
  const speedLegend = h('span', { class: 'ramp-legend' });
  const polarCanvas = h('canvas', { class: 'plot plot-square' });
  const speedCanvas = h('canvas', { class: 'plot plot-speed' });
  const glideCanvas = h('canvas', { class: 'plot plot-small' });
  const altCanvas = h('canvas', { class: 'plot plot-small' });
  const cropInput = h('input', { type: 'checkbox', checked: true });
  const tooltip = h('div', { class: 'jump-tooltip', hidden: true });

  root.append(
    head,
    h('div', { class: 'jump-bar' }, tiles, h('div', { class: 'jump-bar-right' }, tabs, unitsButton)),
    h(
      'div',
      { class: 'jump-charts' },
      h(
        'section',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('h4', {}, 'Start profile'),
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
        h(
          'span',
          { class: 'legend' },
          swatch('--series-1'),
          'total speed',
          swatch('--series-2'),
          'horizontal',
          swatch('--series-3'),
          'vertical',
        ),
        h('label', { class: 'crop' }, cropInput, ' Crop at deploy'),
      ),
      h('div', { class: 'panel-title' }, 'Speed'),
      speedCanvas,
      h('div', { class: 'panel-title' }, 'Glide ratio'),
      glideCanvas,
      h('div', { class: 'panel-title' }, 'Height above ground'),
      altCanvas,
    ),
    tooltip,
  );

  const profile = new Plot(profileCanvas);
  profile.square = true;
  const polar = new Plot(polarCanvas);
  polar.square = true;
  const speedPlot = new Plot(speedCanvas);
  const glidePlot = new Plot(glideCanvas);
  const altPlot = new Plot(altCanvas);
  const timePlots = [speedPlot, glidePlot, altPlot];
  for (const p of [speedPlot, glidePlot]) p.pad.b = 22;

  // ------------------------------------------------------------ rendering

  const jump = (): Jump => jumps[state.jump];
  /** Series index of the deploy marker, or the last index. */
  const deployK = (): number => {
    const j = jump();
    return (j.deploy ?? j.end) - j.start;
  };

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
      tile('Max speed', speed(s.maxSpeed, u)),
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
    rangeValue.textContent = len(state.profileRange, u);
    rangeInput.value = String(state.profileRange);
    speedLegend.replaceChildren(
      h('span', { class: 'ramp-bar', style: `background: linear-gradient(90deg, ${ramp().join(', ')})` }),
      `0–${Math.round(RAMP_MAX * u.speed)}+ ${u.speedUnit}`,
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
    const vH = scaled(s.velH, u.speed);
    const vD = scaled(s.velD, u.speed);
    const total = scaled(s.speed, u.speed);

    // Start profile: freefall only, until the chosen height is lost.
    const range = state.profileRange * u.length;
    let last = 0;
    while (last < dk && s.drop[last + 1] <= state.profileRange * 1.02) last++;
    const rampColors = ramp();
    profile.x = { min: 0, max: range, title: `Horizontal distance (${u.lengthUnit})` };
    profile.y = { min: 0, max: range, title: `Vertical drop (${u.lengthUnit})`, invert: true };
    profile.refs = [{ x0: 0, y0: 0, x1: range, y1: range, label: '1:1' }];
    profile.lines = [
      {
        x: scaled(s.distance, u.length),
        y: scaled(s.drop, u.length),
        to: last,
        color: rampColors[0],
        colorAt: (i) => rampColors[Math.min(rampColors.length - 1, Math.floor((s.speed[i] / RAMP_MAX) * rampColors.length))],
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
    polar.x = { min: 0, max: xMax, title: `Horizontal (${u.speedUnit})` };
    polar.y = { min: -niceMax(-minVD, 10), max: niceMax(maxVD, 10), title: `Vertical (${u.speedUnit})`, invert: true };
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

    const [speedLo, speedHi] = [Math.min(0, inRange(vD)[0]), Math.max(inRange(total)[1], inRange(vH)[1])];
    speedPlot.x = { ...time, title: '' };
    speedPlot.y = { min: speedLo < 0 ? -niceMax(-speedLo, 5) : 0, max: niceMax(speedHi, 10), title: u.speedUnit };
    speedPlot.lines = [
      { x: s.t, y: total, to: end, color: c.series1 },
      { x: s.t, y: vH, to: end, color: c.series2 },
      { x: s.t, y: vD, to: end, color: c.series3 },
    ];
    speedPlot.refs = deployRef;

    glidePlot.x = { ...time, title: '' };
    glidePlot.y = { min: 0, max: 4, title: 'ratio' };
    glidePlot.lines = [{ x: s.t, y: s.glide, to: end, color: c.series1 }];
    glidePlot.refs = deployRef;

    const agl = scaled(s.agl, u.length);
    altPlot.x = time;
    altPlot.y = { min: Math.min(0, inRange(agl)[0]), max: niceMax(inRange(agl)[1], 10), title: u.lengthUnit };
    altPlot.lines = [{ x: s.t, y: agl, to: end, color: c.ink }];
    altPlot.refs = deployRef;

    for (const p of timePlots) {
      p.cursorX = hover !== null && hover <= end ? s.t[hover] : null;
      const marks: PlotMark[] = [];
      if (hover !== null && hover <= end) {
        for (const line of p.lines) {
          const y = line.y[hover];
          if (Number.isFinite(y)) marks.push({ x: s.t[hover], y, color: line.color });
        }
      }
      p.marks = marks;
      p.draw();
    }
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
      row('--series-1', 'Total speed', speed(s.speed[k], u)),
      row('--series-2', 'Horizontal', speed(s.velH[k], u)),
      row('--series-3', 'Vertical', speed(s.velD[k], u)),
      row(null, 'Glide ratio', Number.isFinite(s.glide[k]) ? s.glide[k].toFixed(2) : '—'),
      row(null, 'Height', `${len(s.agl[k], u)} AGL`),
      row(null, 'Distance', len(s.distance[k], u)),
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

  for (const p of timePlots) {
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
  for (const p of [profile, polar, ...timePlots]) p.canvas.addEventListener('pointerleave', () => setHover(null));

  // ------------------------------------------------------------ controls

  unitsButton.onclick = () => {
    state.units = state.units === 'metric' ? 'imperial' : 'metric';
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

function colors(el: HTMLElement): { series1: string; series2: string; series3: string; ink: string } {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { series1: v('--series-1'), series2: v('--series-2'), series3: v('--series-3'), ink: v('--chart-ink') };
}

function ramp(): string[] {
  return matchMedia('(prefers-color-scheme: dark)').matches ? RAMP.dark : RAMP.light;
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
    return localStorage.getItem('jump.units') === 'imperial' ? 'imperial' : 'metric';
  } catch {
    return 'metric';
  }
}

function saveUnits(units: UnitSystem): void {
  try {
    localStorage.setItem('jump.units', units);
  } catch {
    // Not remembered; applies to this view.
  }
}
