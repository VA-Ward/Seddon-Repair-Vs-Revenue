// Chart.js set-up in one place: theme tokens, thin marks, a crosshair, and an HTML tooltip
// where the value leads and the label follows. Charts re-draw when the theme changes.

const registry = new Map();
let themeHooked = false;

export function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    card: v('--card'), ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), rule: v('--rule'), rule2: v('--rule-2'),
    tag: v('--tag'), s1: v('--s1'), s2: v('--s2'), s3: v('--s3'), bar: v('--bar'), barHi: v('--bar-hi'),
    font: v('--font') || 'system-ui, sans-serif',
  };
}

function hookTheme() {
  if (themeHooked) return;
  themeHooked = true;
  const redraw = () => { for (const [, entry] of registry) entry.render(); };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// ---- plugins ----
const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart, _args, opts) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length || opts.off) return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = opts.color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, top); ctx.lineTo(Math.round(x) + 0.5, bottom); ctx.stroke();
    ctx.restore();
  },
};
const selectedBand = {
  id: 'selectedBand',
  beforeDatasetsDraw(chart, _args, opts) {
    if (opts.index == null || opts.index < 0) return;
    const xs = chart.scales.x;
    if (!xs || opts.index >= chart.data.labels.length) return;
    const x = xs.getPixelForValue(opts.index);
    const w = Math.max(6, (xs.width / Math.max(1, chart.data.labels.length)) * 0.9);
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save(); ctx.globalAlpha = 0.45; ctx.fillStyle = opts.color;
    ctx.fillRect(x - w / 2, top, w, bottom - top);
    ctx.restore();
  },
};
const zeroLine = {
  id: 'zeroLine',
  beforeDatasetsDraw(chart, _args, opts) {
    if (!opts.on) return;
    const y = chart.scales.y.getPixelForValue(0);
    const { left, right } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save(); ctx.strokeStyle = opts.color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, Math.round(y) + 0.5); ctx.lineTo(right, Math.round(y) + 0.5); ctx.stroke(); ctx.restore();
  },
};

// ---- HTML tooltip ----
function externalTooltip(format, extraFn) {
  return (context) => {
    const { chart, tooltip } = context;
    let el = chart.canvas.parentNode.querySelector('.tip');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tip';
      el.setAttribute('role', 'status');
      Object.assign(el.style, {
        position: 'absolute', pointerEvents: 'none', zIndex: 5, minWidth: '150px', maxWidth: '240px',
        background: 'var(--card)', border: '1px solid var(--rule-2)', borderRadius: '8px', padding: '8px 10px',
        boxShadow: '0 6px 18px rgba(0,0,0,.12)', fontSize: '12.5px', lineHeight: '1.35', color: 'var(--ink)', transition: 'opacity .08s',
      });
      chart.canvas.parentNode.appendChild(el);
    }
    if (tooltip.opacity === 0) { el.style.opacity = 0; return; }
    el.textContent = '';
    const head = document.createElement('div');
    head.textContent = tooltip.title?.[0] || '';
    Object.assign(head.style, { color: 'var(--ink-3)', fontSize: '11.5px', marginBottom: '4px' });
    el.appendChild(head);
    const points = [...tooltip.dataPoints].sort((a, b) => (a.dataset.order ?? 0) - (b.dataset.order ?? 0));
    for (const p of points) {
      if (p.raw == null || (p.dataset.hideZeroInTip && !p.raw)) continue;
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'grid', gridTemplateColumns: '14px auto 1fr', alignItems: 'center', gap: '7px', padding: '1px 0' });
      const k = document.createElement('i');
      const col = p.dataset.keyColor || p.dataset.borderColor;
      Object.assign(k.style, { display: 'block', width: '12px', height: p.dataset.type === 'line' ? '2px' : '8px', borderRadius: '2px', background: typeof col === 'string' ? col : 'var(--ink-3)' });
      const val = document.createElement('strong');
      val.textContent = (p.dataset.fmt || format)(p.raw, p);
      Object.assign(val.style, { fontWeight: '650', fontVariantNumeric: 'tabular-nums' });
      const lab = document.createElement('span');
      lab.textContent = p.dataset.label;
      Object.assign(lab.style, { color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
      row.append(k, val, lab);
      el.appendChild(row);
    }
    const extra = typeof extraFn === 'function' ? extraFn(tooltip.dataPoints?.[0]?.dataIndex) : null;
    if (extra) { const ex = document.createElement('div'); ex.textContent = extra; Object.assign(ex.style, { color: 'var(--ink-3)', fontSize: '11.5px', marginTop: '4px' }); el.appendChild(ex); }
    el.style.opacity = 1;
    const pw = chart.canvas.parentNode.clientWidth;
    const w = el.offsetWidth;
    let x = tooltip.caretX + 14;
    if (x + w > pw) x = tooltip.caretX - w - 14;
    el.style.left = `${Math.max(0, x)}px`;
    el.style.top = `${Math.max(0, Math.min(tooltip.caretY - 20, chart.height - el.offsetHeight))}px`;
  };
}

// Stacked bars: round only the top of the highest visible segment, and leave a 2px surface gap between segments.
function stackInfo(ctx) {
  const { chart, dataIndex, datasetIndex } = ctx;
  const ds = chart.data.datasets;
  const me = ds[datasetIndex];
  let above = false, below = false;
  ds.forEach((d, j) => {
    if (j === datasetIndex || d.type === 'line' || d.stack !== me.stack || !chart.isDatasetVisible(j)) return;
    const v = d.data[dataIndex] || 0;
    if (v > 0 && j > datasetIndex) above = true;
    if (v > 0 && j < datasetIndex) below = true;
  });
  return { above, below };
}

/**
 * spec: { labels, datasets:[{label, type:'bar'|'line', data, color:'s1'|..., stack, neutral:true, dashed:false, fmt}],
 *         y: { fmt:(n)=>string, min, max, beginAtZero, suggestedMax }, selectedIndex, onPick(index), tipExtra(index),
 *         stacked, zero }
 */
export function draw(id, canvas, specFn) {
  hookTheme();
  const entry = registry.get(id) || {};
  entry.render = () => {
    const spec = specFn();
    const t = tokens();
    const Chart = window.Chart;
    if (!Chart) return;
    if (entry.chart) entry.chart.destroy();
    const colorOf = (c) => (c && t[c]) || c || t.ink2;
    const datasets = spec.datasets.map((d, i) => {
      const base = { label: d.label, data: d.data, order: d.order ?? i, fmt: d.fmt, hideZeroInTip: d.hideZeroInTip };
      if (d.type === 'line') {
        const c = colorOf(d.color);
        return {
          ...base, type: 'line', borderColor: c, keyColor: c, backgroundColor: d.fill ? hexA(c, 0.1) : 'transparent', fill: d.fill ? 'origin' : false,
          borderWidth: d.thin ? 1.5 : 2, tension: 0, spanGaps: d.spanGaps ?? false, borderCapStyle: 'round', borderJoinStyle: 'round',
          pointRadius: (ctx) => (d.endDot && ctx.dataIndex === lastIndex(d.data) ? 4 : 0),
          pointHoverRadius: 4, pointBackgroundColor: c, pointBorderColor: t.card, pointBorderWidth: 2, pointHitRadius: 12, order: d.order ?? -1,
        };
      }
      const c = d.neutral ? null : colorOf(d.color);
      const bg = d.neutral
        ? (ctx) => (ctx.dataIndex === spec.selectedIndex ? t.barHi : t.bar)
        : (d.signed ? (ctx) => (ctx.raw < 0 ? hexA(c, 0.55) : c) : c);
      return {
        ...base, type: 'bar', stack: d.stack || (spec.stacked ? 'a' : `s${i}`), backgroundColor: bg, keyColor: d.neutral ? t.bar : c,
        borderColor: t.card, borderSkipped: false,
        borderWidth: (ctx) => (spec.stacked && stackInfo(ctx).below ? { top: 0, left: 0, right: 0, bottom: 2 } : 0),
        borderRadius: (ctx) => {
          if (spec.stacked && stackInfo(ctx).above) return 0;
          return (ctx.raw ?? 0) < 0 ? { bottomLeft: 4, bottomRight: 4, topLeft: 0, topRight: 0 } : { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 };
        },
        maxBarThickness: 24, categoryPercentage: 0.78, barPercentage: 0.9,
      };
    });
    const yfmt = spec.y?.fmt || ((n) => n);
    entry.chart = new Chart(canvas, {
      data: { labels: spec.labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 6, right: 6 } },
        onClick: (_e, els, chart) => {
          if (!spec.onPick) return;
          const a = chart.tooltip?.getActiveElements?.() || els;
          if (a.length) spec.onPick(a[0].index);
        },
        onHover: (e, els) => { if (spec.onPick) e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        scales: {
          x: {
            stacked: !!spec.stacked, grid: { display: false }, border: { color: t.rule2 },
            ticks: { color: t.ink3, font: { family: t.font, size: 11 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 14 },
          },
          y: {
            stacked: !!spec.stacked, beginAtZero: spec.y?.beginAtZero ?? true, min: spec.y?.min, max: spec.y?.max, suggestedMax: spec.y?.suggestedMax,
            grid: { color: t.rule, lineWidth: 1, drawTicks: false }, border: { display: false },
            ticks: { color: t.ink3, font: { family: t.font, size: 11 }, padding: 8, maxTicksLimit: 6, callback: (v) => yfmt(v, true) },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false, external: externalTooltip((v) => yfmt(v), spec.tipExtra), mode: 'index', intersect: false },
          crosshair: { color: t.rule2 },
          selectedBand: { index: spec.band === false ? -1 : spec.selectedIndex, color: t.tag },
          zeroLine: { on: !!spec.zero, color: t.rule2 },
        },
      },
      plugins: [crosshair, selectedBand, zeroLine],
    });
  };
  registry.set(id, entry);
  entry.render();
  return entry;
}

export function destroyAll(prefix = '') {
  for (const [id, entry] of registry) if (id.startsWith(prefix)) { entry.chart?.destroy(); registry.delete(id); }
}

function lastIndex(arr) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i; return -1; }

function hexA(color, a) {
  const c = String(color).trim();
  const m = c.match(/^#([0-9a-f]{6})$/i);
  if (!m) return c;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function legendHTML(items) {
  // items: [{label, color(var name or css), line:bool}]
  const wrap = document.createElement('div');
  wrap.className = 'legend';
  for (const it of items) {
    const s = document.createElement('span');
    const k = document.createElement('i');
    k.className = `key${it.line ? ' line' : ''}`;
    k.style.setProperty('--k', it.color.startsWith('--') ? `var(${it.color})` : it.color);
    const l = document.createElement('span');
    l.textContent = it.label;
    s.append(k, l);
    wrap.appendChild(s);
  }
  return wrap;
}
