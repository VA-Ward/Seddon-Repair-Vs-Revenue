// Seddon Workroom dashboard.
import { buildModel, forecast, insights, historyNeededVsRostered, runningGap, productivity, lastWorked, backlogAt } from './lib/model.js';
import { fmtDate, fmtRange, addDays } from './lib/dates.js';
import { money, moneyK, int, hrs, pct, signedPct, plural } from './lib/format.js';
import { unlockKey, readVault, decryptBytes } from './lib/vault.js';
import { draw, destroyAll, legendHTML } from './charts.js';

// ---------- tiny DOM helper (text always goes in as text) ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) { if (val == null) continue; if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val; }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only ever used with fixed markup
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (s, r = document) => r.querySelector(s);

// ---------- state ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(`seddon.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`seddon.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const S = {
  mode: 'plain', data: null, model: null, idx: 0, view: 'overview', range: store.get('range', '6m'), month: null,
  roster: { available: {}, catchUp: true, extra: 0 }, key: null, localRates: store.get('rates', {}), photoCache: new Map(),
};
const VIEWS = ['overview', 'roster', 'repairs', 'intake', 'store', 'months', 'photos', 'checks'];
const RANGES = { '3m': 13, '6m': 26, '12m': 52, all: 9999 };
const COLOR = { serin: '--s1', lily: '--s2' };
const staffColor = (id, i) => COLOR[id] || ['--s1', '--s2', '--s3'][i % 3];

// ---------- boot ----------
async function boot() {
  let vault = null, plain = null;
  try { const r = await fetch('data/vault.json', { cache: 'no-store' }); if (r.ok) vault = await r.json(); } catch { /* not there */ }
  if (!vault) {
    try { const r = await fetch('data/seddon-data.json', { cache: 'no-store' }); if (r.ok) plain = await r.json(); } catch { /* not there */ }
  }
  $('#boot').hidden = true;
  if (vault) { S.mode = 'vault'; S.vault = vault; return tryRememberedKey(); }
  if (plain) { S.mode = 'plain'; return start(plain); }
  $('#boot').hidden = false;
  $('#boot').textContent = 'No data file found. Upload the site files again or open the Admin page to import the workbook.';
}

async function tryRememberedKey() {
  let saved = null;
  try { saved = sessionStorage.getItem('seddon.key') || localStorage.getItem('seddon.key'); } catch { /* blocked */ }
  if (saved) {
    try {
      const key = Uint8Array.from(atob(saved), (c) => c.charCodeAt(0));
      const data = await readVault(S.vault, key);
      S.key = key;
      return start(data);
    } catch { try { sessionStorage.removeItem('seddon.key'); localStorage.removeItem('seddon.key'); } catch { /* ignore */ } }
  }
  showLock();
}

function showLock(msg) {
  const lock = $('#lock');
  lock.hidden = false; lock.className = 'lock';
  lock.textContent = '';
  const err = h('p', { class: 'err', role: 'alert' }, msg || '');
  const input = h('input', { id: 'pass', type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Passphrase' });
  const remember = h('input', { id: 'remember', type: 'checkbox' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Unlock');
  const form = h('form', null,
    h('span', { class: 'ticket' }, 'Master Dry Cleaners'),
    h('h1', null, 'Seddon Workroom'),
    h('p', { class: 'muted' }, 'Repairs, takings and wages for Seddon. The figures are encrypted — enter the passphrase to open them.'),
    h('label', { class: 'field', for: 'pass' }, 'Passphrase', input),
    h('label', { class: 'check' }, remember, 'Remember on this device'),
    err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true; btn.textContent = 'Unlocking…'; err.textContent = '';
    try {
      const key = await unlockKey(S.vault, input.value);
      const data = await readVault(S.vault, key);
      S.key = key;
      const b64 = btoa(String.fromCharCode(...key));
      try { (remember.checked ? localStorage : sessionStorage).setItem('seddon.key', b64); } catch { /* ignore */ }
      lock.hidden = true;
      start(data);
    } catch (ex) {
      err.textContent = ex.message === 'wrong-passphrase' ? "That passphrase didn't work. Check it and try again." : `Couldn't open the data: ${ex.message}`;
      btn.disabled = false; btn.textContent = 'Unlock';
    }
  });
  lock.appendChild(form);
  input.focus();
}

function start(data) {
  S.data = data;
  rebuild();
  S.idx = S.model.weeks.length - 1;
  const remembered = store.get('week', null);
  if (remembered && S.model.idxOf[remembered] != null) S.idx = S.model.idxOf[remembered];
  $('#app').hidden = false;
  fillWeekSelect();
  $('#prevWeek').addEventListener('click', () => setWeek(S.idx - 1));
  $('#nextWeek').addEventListener('click', () => setWeek(S.idx + 1));
  $('#weekSelect').addEventListener('change', (e) => setWeek(+e.target.value));
  window.addEventListener('hashchange', route);
  route();
}

function rebuild() {
  const overrides = { staff: {} };
  for (const s of S.data.staff || []) {
    const r = S.localRates[s.id];
    if (!s.payRate && r > 0) overrides.staff[s.id] = { payRate: r };
  }
  if (S.localRates.onCostPct != null) overrides.settings = { onCostPct: S.localRates.onCostPct };
  S.model = buildModel(S.data, overrides);
}

function fillWeekSelect() {
  const sel = $('#weekSelect');
  sel.textContent = '';
  S.model.weeks.forEach((w, i) => sel.appendChild(h('option', { value: i }, `W/E ${fmtDate(w.we)}`)));
  syncWeekUI();
}
function syncWeekUI() {
  $('#weekSelect').value = S.idx;
  $('#prevWeek').disabled = S.idx <= 0;
  $('#nextWeek').disabled = S.idx >= S.model.weeks.length - 1;
  const w = S.model.weeks[S.idx];
  $('#weekTicket').textContent = S.idx === S.model.weeks.length - 1 ? 'Latest week' : `${S.model.weeks.length - 1 - S.idx} wk${S.model.weeks.length - 1 - S.idx === 1 ? '' : 's'} back`;
  $('#weekTicket').title = `Week ending ${fmtDate(w.we, { weekday: true })}`;
}
function setWeek(i) {
  if (i < 0 || i >= S.model.weeks.length) return;
  S.idx = i;
  store.set('week', S.model.weeks[i].we);
  syncWeekUI();
  render();
}

function route() {
  const v = (location.hash || '#overview').slice(1);
  S.view = VIEWS.includes(v) ? v : 'overview';
  for (const a of document.querySelectorAll('#tabs a')) a.setAttribute('aria-current', a.getAttribute('href') === `#${S.view}` ? 'page' : 'false');
  render();
}

function render() {
  destroyAll();
  const view = $('#view');
  view.textContent = '';
  ({ overview, roster, repairs, intake, store: storeView, months, photos, checks })[S.view](view);
  renderFoot();
  const open = document.querySelector('#tabs a[aria-current="page"]');
  open?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

// ---------- shared bits ----------
const weekRange = () => {
  const n = RANGES[S.range] || 26;
  const end = S.idx;
  return { from: Math.max(0, end - n + 1), to: end };
};
function rangeControl(onChange) {
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period shown' });
  for (const [k, label] of [['3m', '3 months'], ['6m', '6 months'], ['12m', '12 months'], ['all', 'All']]) {
    seg.appendChild(h('button', { type: 'button', 'aria-pressed': String(S.range === k), onclick: () => { S.range = k; store.set('range', k); (onChange || render)(); } }, label));
  }
  return seg;
}
function panel(cls, title, sub, ...kids) {
  return h('section', { class: `panel ${cls || ''}` }, (title || sub) ? h('header', null, title ? h('h2', null, title) : null, sub ? h('p', null, sub) : null) : null, ...kids);
}
function chartBox(cls = '') { const c = h('canvas', { role: 'img' }); const box = h('div', { class: `chart ${cls}` }, c); return { box, canvas: c }; }
function tableToggle(label, table) {
  return h('details', { class: 'table' }, h('summary', null, label), h('div', { class: 'scroll' }, table));
}
function dataTable(head, rows, opts = {}) {
  const t = h('table');
  if (opts.groups) t.appendChild(h('thead', null, h('tr', { class: 'grp' }, opts.groups.map(([label, span]) => h('th', { colspan: span }, label)))));
  const thead = t.tHead || t.appendChild(h('thead'));
  thead.appendChild(h('tr', null, head.map((x) => h('th', { scope: 'col' }, x))));
  const tb = h('tbody');
  for (const r of rows) tb.appendChild(h('tr', { class: r.cls || null }, r.cells.map((c) => (c instanceof Node ? h('td', null, c) : h('td', { class: c === '—' ? 'off' : null }, c)))));
  t.appendChild(tb);
  return t;
}
function delta(cur, base, { goodUp = true, label } = {}) {
  if (cur == null || !base) return null;
  const d = cur / base - 1;
  const dir = Math.abs(d) < 0.01 ? 'flat' : (d > 0) === goodUp ? 'up' : 'down';
  return h('span', null, h('span', { class: `delta ${dir}` }, `${d > 0 ? '▲' : d < 0 ? '▼' : '■'} ${signedPct(d)}`), label ? ` ${label}` : '');
}
function tile(label, value, note, extra) {
  return h('div', { class: 'tile' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value), note ? h('span', { class: 'note' }, note) : null, extra || null);
}
function flagMark(text) { return h('span', { class: 'flag', title: text, 'aria-label': text }, '!'); }
function issuesFor(we, staff) { return (S.data.issues || []).filter((i) => i.we === we && (staff === undefined || i.staff === staff || (staff === 'other' && !i.staff))); }
function toast(msg) { const t = h('div', { class: 'toast', role: 'status' }, msg); document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }
const W = () => S.model.weeks[S.idx];
const staffList = () => S.model.staff;

function weekLabels(from, to) { return S.model.weeks.slice(from, to + 1).map((w) => fmtDate(w.we, { short: true })); }

// ---------- roster card (Overview + Roster) ----------
function rosterCard(f, compact) {
  if (!f.ok) return h('div', { class: 'empty' }, h('strong', null, 'No forecast for this week'), h('span', null, f.reason));
  const people = f.people.filter((p) => p.days > 0);
  const parts = people.map((p) => `${p.name} ${plural(p.days, 'day')}`);
  if (f.cover.days) parts.push(`${plural(f.cover.days, 'day')} of cover`);
  const rows = f.people.filter((p) => p.days > 0 || !compact).map((p) => {
    const blocks = h('div', { class: 'days', style: { '--k': `var(${staffColor(p.id)})` }, 'aria-hidden': 'true' });
    for (let d = 0; d < 6; d++) blocks.appendChild(h('i', { class: d < Math.min(p.days, p.usualDays) ? 'on' : d < p.days ? 'extra' : '' }));
    const meta = p.days
      ? `${hrs(p.hours)} · ${money(p.rph, 2)}/h${p.extraDays ? ` · ${plural(p.extraDays, 'extra day')}` : ''}`
      : p.available ? 'Not needed' : `Not rostered · last worked ${p.lastWorked ? fmtDate(p.lastWorked, { short: true }) : '—'}`;
    return h('div', { class: 'crewrow' }, h('div', { class: 'who' }, h('i', { class: 'key', style: { '--k': `var(${staffColor(p.id)})` } }), h('span', null, p.name)), blocks, h('div', { class: 'meta' }, `${p.days ? plural(p.days, 'day') + ' · ' : ''}${meta}`));
  });
  if (f.cover.days) {
    const blocks = h('div', { class: 'days', 'aria-hidden': 'true' });
    for (let d = 0; d < 6; d++) blocks.appendChild(h('i', { class: d < f.cover.days ? 'cover' : '' }));
    rows.push(h('div', { class: 'crewrow' }, h('div', { class: 'who' }, h('i', { class: 'key', style: { '--k': 'var(--ink-3)' } }), h('span', null, 'Cover')), blocks,
      h('div', { class: 'meta' }, `${plural(f.cover.days, 'day')} · ${hrs(f.cover.rosterHours)} · about ${hrs(f.cover.hours)} of work`)));
  }
  const basis = `Covers ${money(f.intake.revenue)} of repairs taken in during the week ending ${fmtDate(f.basedOnWe, { short: true })}`
    + (f.catchUp > 0 ? ` plus ${money(f.catchUp)} towards the ${money(f.backlogPositive)} backlog` : '')
    + (f.extra ? ` plus ${money(f.extra)} of extra work you added` : '')
    + `. The work needs about ${hrs(f.neededHours)}; whole days round it to ${hrs(f.rosterHours)}.`;
  return h('div', { class: 'hero' },
    h('span', { class: 'label' }, `Roster for the week ending ${fmtDate(f.forWe, { weekday: true })}`),
    h('div', { class: 'figure' }, hrs(f.rosterHours).replace(' h', ''), h('small', null, 'hours of sewing')),
    h('p', { class: 'why' }, parts.join(' + ') || 'No days needed'),
    h('div', { class: 'crew' }, rows),
    h('div', { class: 'daylegend' },
      h('span', null, h('i', { style: { background: 'var(--ink-2)' } }), 'Usual days'),
      h('span', null, h('i', { style: { background: 'repeating-linear-gradient(135deg, var(--ink-2) 0 4px, transparent 4px 7px)', border: '1px solid var(--ink-2)' } }), 'Extra days'),
      f.cover.days ? h('span', null, h('i', { style: { background: 'repeating-linear-gradient(45deg, var(--ink-3) 0 4px, transparent 4px 7px)', border: '1px solid var(--ink-3)' } }), 'Cover (Lily or a casual)') : null),
    h('p', { class: 'small muted' }, basis));
}

// ---------- OVERVIEW ----------
function overview(view) {
  const w = W(), m = S.model;
  const prev4 = m.weeks.slice(Math.max(0, S.idx - 4), S.idx);
  const avg = (arr, f) => (arr.length ? arr.reduce((s, x) => s + f(x), 0) / arr.length : null);
  const doneAvg = avg(prev4, (x) => x.done.revenue);
  const pr = (() => { let rev = 0, hh = 0, c = 0; for (let i = S.idx - 1; i >= 0 && c < 8; i--) { const d = m.weeks[i].done; if (d.hours > 0) { rev += d.revenue; hh += d.hours; c++; } } return hh ? rev / hh : null; })();
  const inAvg = avg(prev4.filter((x) => x.intake), (x) => x.intake.revenue);
  const sw = m.storeWeeks[m.tIdx[w.we]];
  const f = forecast(m, S.idx, S.roster);

  view.append(
    h('div', { class: 'viewhead' },
      h('div', null, h('h2', null, `Week ending ${fmtDate(w.we, { weekday: true })}`), h('p', null, `${fmtRange(w.start, w.we)} · ${w.done.hours ? `${int(w.done.orders)} repairs completed` : 'no repair hours recorded'}`)),
    ),
    h('div', { class: 'grid' },
      panel('span-7', null, null, rosterCard(f, true), h('p', { style: { marginTop: '12px' } }, h('a', { href: '#roster' }, 'Change who’s available or add expected work →'))),
      h('div', { class: 'span-5 tiles' },
        tile('Repairs done', money(w.done.revenue), `${int(w.done.orders)} orders · ${hrs(w.done.hours)}`, delta(w.done.revenue, doneAvg, { label: 'on 4-week avg' })),
        tile('Per repair hour', w.done.rph != null ? money(w.done.rph, 2) : '—', 'Revenue ÷ sewing hours', delta(w.done.rph, pr, { label: 'on 8-week avg' })),
        tile('In from other stores', w.intake ? money(w.intake.revenue) : '—', w.intake ? `${int(w.intake.orders)} orders` : 'Not recorded', w.intake ? delta(w.intake.revenue, inAvg, { label: 'on 4-week avg' }) : null),
        tile('Store takings', sw ? money(sw.sales) : '—', sw?.lastYear ? `Last year ${money(sw.lastYear)}` : 'Seddon counter, inc GST', sw?.lastYear ? delta(sw.sales, sw.lastYear, { label: 'on last year' }) : null),
      ),
    ),
  );

  const notes = insights(m, S.idx);
  const ul = h('ul', { class: 'notes' });
  for (const n of notes) {
    const icon = { good: '✓', warn: '!', bad: '!', info: 'i' }[n.tone] || 'i';
    const li = h('li', null, h('span', { class: `ic ${n.tone}`, 'aria-hidden': 'true' }, icon), h('span', null, n.text, ' ',
      n.action === 'rates' ? h('a', { href: '#repairs' }, 'Add rates') : n.action === 'eh' ? h('a', { href: '#store' }, 'Store wages') : n.action === 'checks' ? h('a', { href: '#checks' }, 'Data checks') : null));
    ul.appendChild(li);
  }
  view.appendChild(panel('', 'What stands out this week', 'Written from the figures — it updates when new weeks are added', ul));

  // Work in vs work done
  const { from, to } = weekRange();
  const ws = m.weeks.slice(from, to + 1);
  const c1 = chartBox('tall');
  const staffDs = staffList().map((s, i) => ({ label: `Done — ${s.name}`, type: 'bar', data: ws.map((x) => x.staff[s.id]?.revenue ?? 0), color: staffColor(s.id, i).slice(2), stack: 'done', hideZeroInTip: true }));
  const legend = legendHTML([...staffList().map((s, i) => ({ label: `Done by ${s.name}`, color: staffColor(s.id, i) })), { label: 'In from other stores', color: '--s3', line: true }]);
  const tbl = dataTable(['Week ending', ...staffList().map((s) => s.name), 'Done', 'In from other stores', 'Difference'],
    ws.map((x) => ({ cls: x.we === w.we ? 'sel' : null, cells: [fmtDate(x.we), ...staffList().map((s) => money(x.staff[s.id]?.revenue ?? 0)), money(x.done.revenue), x.intake ? money(x.intake.revenue) : '—', x.intake ? money(x.intake.revenue - x.done.revenue) : '—'] })).reverse());
  view.appendChild(h('div', { class: 'grid' },
    panel('span-8', 'Work in vs work done', 'Repairs completed each week by Serin and Lily, against repairs sent in from other stores',
      h('div', { class: 'controls', style: { marginBottom: '10px' } }, rangeControl()), legend, c1.box, tableToggle('Show the numbers', tbl)),
    gapPanel('span-4'),
  ));
  draw('ov-inout', c1.canvas, () => ({
    labels: weekLabels(from, to), stacked: true, selectedIndex: S.idx - from,
    datasets: [...staffDs, { label: 'In from other stores', type: 'line', data: ws.map((x) => x.intake?.revenue ?? null), color: 's3', endDot: true }],
    y: { fmt: (v, axis) => (axis ? moneyK(v) : money(v)) },
    onPick: (i) => setWeek(from + i),
    tipExtra: (i) => { const x = ws[i]; return x?.intake ? `Difference ${money(x.intake.revenue - x.done.revenue)}` : null; },
  }));

  view.appendChild(wagesSnapshot());
}

function gapPanel(cls) {
  const m = S.model;
  const g = runningGap(m);
  const { from, to } = weekRange();
  const fromWe = m.weeks[from].we, toWe = m.weeks[to].we;
  const pts = g.filter((x) => x.we >= fromWe && x.we <= toWe);
  const cur = backlogAt(m, S.idx);
  const c = chartBox('short');
  const head = cur
    ? (cur.gap > 0 ? `${money(cur.gap)} behind` : cur.gap < 0 ? `${money(-cur.gap)} ahead` : 'Level')
    : '—';
  const sub = cur ? `${money(cur.intake)} in, ${money(cur.done)} done over the last ${cur.weeks} weeks` : 'Needs at least 4 weeks of other-stores figures';
  const p = panel(cls, 'Behind or ahead', 'Work in minus work done the following week, over a rolling 8 weeks',
    h('div', { class: 'tile', style: { border: 0, padding: '0 0 10px' } }, h('span', { class: 'value' }, head), h('span', { class: 'note' }, sub)), c.box,
    tableToggle('Show the numbers', dataTable(['Week ending', 'Behind (+) / ahead (−)'], pts.map((x) => ({ cells: [fmtDate(x.we), money(x.gap)] })).reverse())));
  const selIdx = pts.findIndex((x) => x.we === W().we);
  draw(`gap-${cls}`, c.canvas, () => ({
    labels: pts.map((x) => fmtDate(x.we, { short: true })), selectedIndex: selIdx, band: false, zero: true,
    datasets: [{ label: 'Behind (+) / ahead (−)', type: 'bar', neutral: true, data: pts.map((x) => Math.round(x.gap)) }],
    y: { fmt: (v, axis) => (axis ? moneyK(v) : money(v)), beginAtZero: true },
    onPick: (i) => { const we = pts[i]?.we; if (we) setWeek(S.model.idxOf[we]); },
  }));
  return p;
}

function wagesSnapshot() {
  const m = S.model, w = W();
  const fns = m.fortnights.filter((f) => f.wagePct != null && f.periodEnd <= w.we).slice(-8);
  const last = fns.at(-1);
  const c = chartBox('short');
  const staleDays = last ? Math.round((new Date(w.we) - new Date(last.periodEnd)) / 864e5) : null;
  const left = panel('span-6', 'Store wages vs takings', last ? `Fortnight ending ${fmtDate(last.periodEnd)}${staleDays > 14 ? ` · no wage figures since (${plural(Math.floor(staleDays / 7), 'week')})` : ''}` : 'No wage figures yet',
    last ? h('div', { class: 'tiles' },
      tile('Wages', money(last.amount), last.source === 'eh' ? 'Employment Hero' : 'Weekly sales sheet'),
      tile('Share of takings', pct(last.wagePct), `of ${money(last.exGst)} ex GST`)) : null,
    c.box, h('p', { class: 'small muted', style: { marginTop: '8px' } }, h('a', { href: '#store' }, 'All fortnights and takings →')));
  if (fns.length) draw('ov-wagepct', c.canvas, () => ({
    labels: fns.map((f) => fmtDate(f.periodEnd, { short: true })), selectedIndex: fns.length - 1, band: false,
    datasets: [{ label: 'Wages as % of takings ex GST', type: 'bar', neutral: true, data: fns.map((f) => Math.round(f.wagePct * 1000) / 10), fmt: (v) => `${v}%` }],
    y: { fmt: (v) => `${v}%` },
  }));
  return h('div', { class: 'grid' }, left, repairWagePanel('span-6'));
}

function repairWagePanel(cls) {
  const m = S.model, w = W();
  const anyRate = staffList().some((s) => s.payRate);
  const fromData = (S.data.staff || []).some((s) => s.payRate);
  const body = [];
  if (w.done.wageKnown) {
    body.push(h('div', { class: 'tiles' },
      tile('Repair wages this week', money(w.done.wageCost), staffList().some((s) => w.staff[s.id]?.wage?.source === 'eh') ? 'From Employment Hero' : `Hours × rate + ${m.settings.onCostPct}% on-costs`),
      tile('Share of repairs revenue', pct(w.done.wagePct), `of ${money(w.done.revenue / (1 + m.settings.gstRate))} ex GST`)));
  }
  const inputs = h('div', { class: 'controls', style: { alignItems: 'end' } });
  for (const s of staffList()) {
    const inp = h('input', { id: `rate-${s.id}`, type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: '0.00', value: s.payRate ?? '' });
    if (fromData && (S.data.staff.find((x) => x.id === s.id)?.payRate)) inp.disabled = true;
    inputs.appendChild(h('label', { class: 'field', for: `rate-${s.id}` }, `${s.name} $/h`, inp));
  }
  const oc = h('input', { id: 'rate-oncost', type: 'number', min: '0', max: '60', step: '0.5', value: m.settings.onCostPct });
  inputs.appendChild(h('label', { class: 'field', for: 'rate-oncost' }, 'On-costs %', oc));
  const save = h('button', { class: 'btn ghost', type: 'button' }, 'Apply');
  save.addEventListener('click', () => {
    const next = { ...S.localRates };
    for (const s of staffList()) { const v = parseFloat($(`#rate-${s.id}`).value); if (v > 0) next[s.id] = v; else delete next[s.id]; }
    const ocv = parseFloat(oc.value); if (Number.isFinite(ocv)) next.onCostPct = ocv;
    S.localRates = next; store.set('rates', next); rebuild(); render(); toast('Rates applied on this device');
  });
  inputs.appendChild(save);
  return panel(cls, 'Repair wages vs repairs revenue', anyRate ? (fromData ? 'Rates set in Admin' : 'Using rates entered on this device') : 'Add each seamstress’s hourly rate to compare wages with what she brings in',
    ...body,
    h('p', { class: 'small muted', style: { margin: '6px 0 10px' } }, fromData ? 'Rates come from the Admin settings. Employment Hero figures replace them when connected.' : 'Rates typed here stay on this device only. Set them for everyone in Admin → Settings, or connect Employment Hero.'),
    inputs);
}

// ---------- ROSTER ----------
function roster(view) {
  const m = S.model, w = W();
  const f = forecast(m, S.idx, S.roster);
  view.appendChild(h('div', { class: 'viewhead' },
    h('div', null, h('h2', null, 'Roster planner'), h('p', null, 'Hours of sewing to roster next week, worked out from the repairs taken in the week before. Change the week at the top to see what it would have said for any past week.'))));

  const avail = h('div', { class: 'controls' });
  for (const p of (f.ok ? f.people : staffList().map((s) => ({ id: s.id, name: s.name, available: true })))) {
    const lw = lastWorked(m, S.idx, p.id);
    const cb = h('input', { type: 'checkbox', id: `av-${p.id}` });
    cb.checked = p.available;
    cb.addEventListener('change', () => { S.roster.available = { ...S.roster.available, [p.id]: cb.checked }; render(); });
    avail.appendChild(h('label', { class: 'check', for: `av-${p.id}` }, cb, `${p.name} available`, h('span', { class: 'muted small' }, lw ? ` (last worked ${fmtDate(lw, { short: true })})` : '')));
  }
  const cu = h('input', { type: 'checkbox', id: 'catchup' }); cu.checked = S.roster.catchUp !== false;
  cu.addEventListener('change', () => { S.roster.catchUp = cu.checked; render(); });
  const ex = h('input', { id: 'extra', type: 'number', min: '0', step: '50', value: S.roster.extra || '', placeholder: '0', inputmode: 'numeric' });
  ex.addEventListener('change', () => { S.roster.extra = Math.max(0, parseFloat(ex.value) || 0); render(); });
  const reset = h('button', { type: 'button', class: 'linkbtn' }, 'Reset');
  reset.addEventListener('click', () => { S.roster = { available: {}, catchUp: true, extra: 0 }; render(); });
  view.appendChild(panel('', null, null, h('div', { class: 'controls', style: { justifyContent: 'space-between' } },
    avail,
    h('label', { class: 'check', for: 'catchup' }, cu, `Clear the backlog over ${m.settings.catchUpWeeks} weeks`),
    h('label', { class: 'field', for: 'extra', style: { gridAutoFlow: 'column', alignItems: 'center', gap: '8px' } }, 'Extra work expected $', ex),
    reset)));

  const how = h('dl', { class: 'kv' });
  const add = (k, v) => how.append(h('dt', null, k), h('dd', null, v));
  if (f.ok) {
    add(`Taken in, W/E ${fmtDate(f.basedOnWe, { short: true })}`, `${money(f.intake.revenue)} · ${int(f.intake.orders)} orders`);
    if (f.backlog) add(`Backlog (last ${f.backlog.weeks} wks)`, `${money(Math.max(0, f.backlog.gap))}${f.catchUpOn && f.catchUp ? ` → ${money(f.catchUp)} this week` : f.backlog.gap <= 0 ? ' (none)' : ' (not included)'}`);
    if (f.extra) add('Extra work added', money(f.extra));
    add('Work to cover', money(f.work));
    for (const p of f.people) add(`${p.name}’s rate`, `${money(p.rph, 2)}/h (last ${p.rphWeeks || '—'} worked wks)`);
    add('Hours the work needs', hrs(f.neededHours));
    add('Hours rostered', `${hrs(f.rosterHours)} (whole days)`);
  }
  view.appendChild(h('div', { class: 'grid' },
    panel('span-7', null, null, rosterCard(f, false)),
    panel('span-5', 'How it’s worked out', null, how,
      h('ol', { class: 'steps', style: { marginTop: '14px' } },
        h('li', null, 'Repairs sent in from other stores in a week get sewn the following week. Over Jan–Aug 2026 the work done each month matched the work sent in to within about 10%.'),
        h('li', null, 'Any shortfall over the last 8 weeks is spread over the next few weeks so it gets cleared.'),
        h('li', null, 'Each person’s recent revenue per hour turns dollars of work into hours. Their usual days are filled first, then extra days, then cover.')),
      f.ok ? h('p', { class: 'small', style: { marginTop: '12px' } }, h('strong', null, `Week ending ${fmtDate(f.indicative.forWe, { short: true })} (indicative): `), `about ${hrs(f.indicative.hours)}, if work coming in stays near the 4-week average of ${money(f.indicative.avgIntake)}.`) : null),
  ));

  // History: needed vs rostered
  const hist = historyNeededVsRostered(m);
  const { from, to } = weekRange();
  const fromWe = m.weeks[from].we, toWe = m.weeks[to].we;
  const pts = hist.filter((x) => x.we >= fromWe && x.we <= toWe);
  const c = chartBox('tall');
  const tbl = dataTable(['Week ending', 'Hours needed', 'Hours rostered', 'Difference'], pts.map((x) => ({ cls: x.we === w.we ? 'sel' : null, cells: [fmtDate(x.we), hrs(x.needed), hrs(x.rostered), hrs(x.rostered - x.needed)] })).reverse());
  view.appendChild(panel('', 'Hours needed vs hours rostered', 'Needed = last week’s incoming work ÷ the seamstresses’ recent revenue per hour (no backlog included)',
    h('div', { class: 'controls', style: { marginBottom: '10px' } }, rangeControl()),
    legendHTML([...staffList().map((s, i) => ({ label: `Rostered — ${s.name}`, color: staffColor(s.id, i) })), { label: 'Hours needed to keep up', color: '--ink', line: true }]),
    c.box, tableToggle('Show the numbers', tbl)));
  draw('ro-hist', c.canvas, () => ({
    labels: pts.map((x) => fmtDate(x.we, { short: true })), stacked: true, selectedIndex: pts.findIndex((x) => x.we === w.we),
    datasets: [
      ...staffList().map((s, i) => ({ label: s.name, type: 'bar', stack: 'r', color: staffColor(s.id, i).slice(2), data: pts.map((x) => m.weeks[m.idxOf[x.we]].staff[s.id]?.hours ?? 0), fmt: (v) => hrs(v), hideZeroInTip: true })),
      { label: 'Needed', type: 'line', color: 'ink', data: pts.map((x) => Math.round(x.needed * 10) / 10), fmt: (v) => hrs(v), endDot: true },
    ],
    y: { fmt: (v, axis) => (axis ? `${v} h` : hrs(v)) },
    onPick: (i) => setWeek(m.idxOf[pts[i].we]),
  }));
  view.appendChild(h('div', { class: 'grid' }, gapPanel('span-12')));
}

// ---------- REPAIRS & WAGES ----------
function repairs(view) {
  const m = S.model, w = W();
  const { from, to } = weekRange();
  const ws = m.weeks.slice(from, to + 1);
  view.appendChild(h('div', { class: 'viewhead' },
    h('div', null, h('h2', null, 'Repairs & wages'), h('p', null, 'What each seamstress brings in against the hours she works and what those hours cost.')),
    rangeControl()));

  const cards = staffList().map((s, i) => {
    const r = w.staff[s.id];
    const p = productivity(m, S.idx, s.id);
    const lw = lastWorked(m, S.idx, s.id);
    const inRange = ws.map((x) => x.staff[s.id]).filter((x) => x && x.hours > 0);
    const tot = inRange.reduce((a, x) => ({ rev: a.rev + x.revenue, h: a.h + x.hours, o: a.o + x.orders, wc: x.wage?.cost != null ? a.wc + x.wage.cost : a.wc, wk: a.wk && x.wage?.cost != null }), { rev: 0, h: 0, o: 0, wc: 0, wk: true });
    return panel('span-6', null, null,
      h('div', { class: 'crewrow', style: { gridTemplateColumns: 'auto 1fr', marginBottom: '12px' } },
        h('div', { class: 'who' }, h('i', { class: 'key', style: { '--k': `var(${staffColor(s.id, i)})` } }), h('h3', null, s.name)),
        h('div', { class: 'meta' }, r && r.hours > 0 ? `This week: ${plural(r.days, 'day')}, ${hrs(r.hours)}` : lw ? `Last worked W/E ${fmtDate(lw, { short: true })}` : 'No hours recorded')),
      h('div', { class: 'tiles' },
        tile('This week', r && r.hours > 0 ? money(r.revenue) : '—', r && r.hours > 0 ? `${int(r.orders)} orders · ${money(r.rph, 2)}/h` : 'Didn’t work'),
        tile(`Per hour, last ${p?.weeks || 0} worked wks`, p ? money(p.rph, 2) : '—', inRange.length ? `${S.range === 'all' ? 'All weeks' : `Last ${S.range.replace('m', ' months')}`}: ${money(tot.rev)} in ${hrs(tot.h)}` : 'No hours in this period'),
        tile('Wage cost in period', tot.wk && inRange.length ? money(tot.wc) : '—', tot.wk && inRange.length ? `${pct(tot.wc / (tot.rev / (1 + m.settings.gstRate)))} of revenue ex GST` : s.payRate ? '' : 'Needs a pay rate or Employment Hero'),
        tile('Orders per hour', tot.h ? (tot.o / tot.h).toFixed(2) : '—', tot.h ? `${money(tot.rev / Math.max(1, tot.o), 2)} per order` : '')));
  });
  view.appendChild(h('div', { class: 'grid' }, cards));

  // Revenue by seamstress + wage cost
  const c1 = chartBox('tall');
  const wageLine = ws.map((x) => (x.done.wageKnown ? Math.round(x.done.wageCost) : null));
  const hasWage = wageLine.some((v) => v != null);
  view.appendChild(panel('', 'Repairs revenue by seamstress', hasWage ? 'Bars are revenue (inc GST); the line is what the hours cost' : 'Add pay rates (below) or connect Employment Hero to draw the wage-cost line',
    legendHTML([...staffList().map((s, i) => ({ label: s.name, color: staffColor(s.id, i) })), ...(hasWage ? [{ label: 'Wage cost', color: '--ink', line: true }] : [])]),
    c1.box));
  draw('rp-rev', c1.canvas, () => ({
    labels: ws.map((x) => fmtDate(x.we, { short: true })), stacked: true, selectedIndex: S.idx - from,
    datasets: [
      ...staffList().map((s, i) => ({ label: s.name, type: 'bar', stack: 'r', color: staffColor(s.id, i).slice(2), data: ws.map((x) => x.staff[s.id]?.revenue ?? 0), hideZeroInTip: true })),
      ...(hasWage ? [{ label: 'Wage cost', type: 'line', color: 'ink', data: wageLine }] : []),
    ],
    y: { fmt: (v, axis) => (axis ? moneyK(v) : money(v)) },
    onPick: (i) => setWeek(from + i),
  }));

  // $ per hour
  const c2 = chartBox();
  const rateLines = staffList().filter((s) => s.payRate).map((s) => ({ label: `${s.name}’s cost per hour`, type: 'line', color: 'ink3', thin: true, data: ws.map(() => Math.round(s.payRate * (1 + m.settings.onCostPct / 100) * 100) / 100) }));
  view.appendChild(panel('', 'Revenue per repair hour', 'Repairs revenue ÷ sewing hours, each week she worked',
    legendHTML([...staffList().map((s, i) => ({ label: s.name, color: staffColor(s.id, i), line: true })), ...(rateLines.length ? [{ label: 'Hourly cost incl. on-costs', color: '--ink-3', line: true }] : [])]),
    c2.box));
  draw('rp-rph', c2.canvas, () => ({
    labels: ws.map((x) => fmtDate(x.we, { short: true })), selectedIndex: S.idx - from,
    datasets: [
      ...staffList().map((s, i) => ({ label: s.name, type: 'line', color: staffColor(s.id, i).slice(2), data: ws.map((x) => (x.staff[s.id]?.hours > 0 ? Math.round(x.staff[s.id].rph * 100) / 100 : null)), endDot: true, fmt: (v) => money(v, 2) })),
      ...rateLines.map((r) => ({ ...r, fmt: (v) => money(v, 2) })),
    ],
    y: { fmt: (v, axis) => (axis ? money(v) : money(v, 2)), beginAtZero: true },
    onPick: (i) => setWeek(from + i),
  }));

  view.appendChild(repairWagePanel(''));

  // weekly table
  const groups = [['', 1], ...staffList().map((s) => [s.name, 5]), ['Workroom', 3]];
  const head = ['Week ending', ...staffList().flatMap(() => ['Orders', 'Revenue', 'Hours', '$/h', 'Wages']), 'Revenue', 'Hours', 'Wages %'];
  const rows = ws.map((x) => ({
    cls: x.we === w.we ? 'sel' : null,
    cells: [
      fmtDate(x.we),
      ...staffList().flatMap((s) => {
        const r = x.staff[s.id];
        if (!r || !(r.hours > 0)) return ['—', '—', '—', '—', '—'];
        const iss = issuesFor(x.we, s.id).filter((i) => !i.fixed);
        const rev = iss.length ? h('span', null, money(r.revenue), flagMark(iss.map((i) => i.title).join('; '))) : money(r.revenue);
        return [int(r.orders), rev, hrs(r.hours), money(r.rph, 2), r.wage?.cost != null ? money(r.wage.cost) : '—'];
      }),
      money(x.done.revenue), hrs(x.done.hours), x.done.wagePct != null ? pct(x.done.wagePct) : '—',
    ],
  })).reverse();
  view.appendChild(panel('', 'Week by week', '! marks a figure worth checking — hover it for why', h('div', { class: 'scroll' }, dataTable(head, rows, { groups }))));
}

// ---------- OTHER STORES ----------
function intake(view) {
  const m = S.model, w = W();
  const { from, to } = weekRange();
  const ws = m.weeks.slice(from, to + 1).filter((x) => x.intake);
  view.appendChild(h('div', { class: 'viewhead' },
    h('div', null, h('h2', null, 'Repairs from other stores'), h('p', null, 'The weekly total of repairs sent to Seddon from the other stores — the work Serin and Lily sew the week after.')),
    rangeControl()));
  const prev4 = m.weeks.slice(Math.max(0, S.idx - 4), S.idx).filter((x) => x.intake);
  const avg4 = prev4.length ? prev4.reduce((s, x) => s + x.intake.revenue, 0) / prev4.length : null;
  const monthSoFar = m.weeks.filter((x) => x.month === w.month && x.we <= w.we && x.intake);
  view.appendChild(h('div', { class: 'tiles four' },
    tile('This week', w.intake ? money(w.intake.revenue) : '—', w.intake ? `${int(w.intake.orders)} orders` : 'Not recorded', w.intake ? delta(w.intake.revenue, avg4, { label: 'on 4-week avg' }) : null),
    tile('4-week average', avg4 != null ? money(avg4) : '—', 'The four weeks before this one'),
    tile('Month so far', monthSoFar.length ? money(monthSoFar.reduce((s, x) => s + x.intake.revenue, 0)) : '—', `${plural(monthSoFar.length, 'week')} of ${new Date(w.we).toLocaleString('en-AU', { month: 'long', timeZone: 'UTC' })}`),
    tile('Average order', w.intake && w.intake.orders ? money(w.intake.revenue / w.intake.orders, 2) : '—', 'Revenue ÷ orders this week')));

  if (!ws.length) { view.appendChild(h('div', { class: 'empty' }, h('strong', null, 'No other-stores figures in this period'), h('span', null, 'They start from January 2026.'))); return; }
  const c = chartBox('tall');
  view.appendChild(panel('', 'Weekly repairs from other stores', 'Repairs revenue (inc GST); hover for the number of orders', c.box,
    tableToggle('Show the numbers', dataTable(['Week ending', 'Orders', 'Repairs $', 'Done the week after', 'Difference'], ws.map((x) => {
      const nx = m.weeks[m.idxOf[x.we] + 1];
      const iss = issuesFor(x.we, 'other').filter((i) => !i.fixed && !i.staff);
      return { cls: x.we === w.we ? 'sel' : null, cells: [fmtDate(x.we), int(x.intake.orders), iss.length ? h('span', null, money(x.intake.revenue), flagMark(iss.map((i) => i.title).join('; '))) : money(x.intake.revenue), nx ? money(nx.done.revenue) : '—', nx ? money(nx.done.revenue - x.intake.revenue) : '—'] };
    }).reverse()))));
  draw('in-weekly', c.canvas, () => ({
    labels: ws.map((x) => fmtDate(x.we, { short: true })), selectedIndex: ws.findIndex((x) => x.we === w.we),
    datasets: [{ label: 'Repairs from other stores', type: 'bar', color: 's3', data: ws.map((x) => x.intake.revenue) }],
    y: { fmt: (v, axis) => (axis ? moneyK(v) : money(v)) },
    tipExtra: (i) => `${int(ws[i]?.intake.orders)} orders · ${money(ws[i]?.intake.revenue / Math.max(1, ws[i]?.intake.orders), 2)} each`,
    onPick: (i) => setWeek(m.idxOf[ws[i].we]),
  }));

  // Monthly in vs done
  const months = m.months.filter((mo) => mo.intake);
  const c2 = chartBox();
  view.appendChild(panel('', 'Month by month: sent in vs sewn', 'Calendar months by week-ending date — the same months as the workbook sheets',
    legendHTML([{ label: 'Sent in from other stores', color: '--s3' }, ...staffList().map((s, i) => ({ label: `Sewn by ${s.name}`, color: staffColor(s.id, i) }))]), c2.box,
    tableToggle('Show the numbers', dataTable(['Month', 'Sent in', 'Sewn', 'Difference', 'Sewn ÷ sent in'], months.map((mo) => ({ cells: [mo.label, money(mo.intake.revenue), money(mo.done.revenue), money(mo.intake.revenue - mo.done.revenue), pct(mo.done.revenue / mo.intake.revenue)] })).reverse()))));
  draw('in-monthly', c2.canvas, () => ({
    labels: months.map((mo) => mo.label.replace(/ (\d{2})(\d{2})$/, ' ’$2')), stacked: true, band: false,
    datasets: [
      { label: 'Sent in', type: 'bar', stack: 'in', color: 's3', data: months.map((mo) => mo.intake.revenue) },
      ...staffList().map((s, i) => ({ label: `Sewn — ${s.name}`, type: 'bar', stack: 'done', color: staffColor(s.id, i).slice(2), data: months.map((mo) => mo.staffTotals[s.id]?.revenue ?? 0), hideZeroInTip: true })),
    ],
    y: { fmt: (v, axis) => (axis ? moneyK(v) : money(v)) },
  }));
}

// ---------- STORE TAKINGS ----------
function storeView(view) {
  const m = S.model, w = W();
  const n = RANGES[S.range] || 26;
  const endT = m.tIdx[w.we] ?? m.storeWeeks.length - 1;
  const sws = m.storeWeeks.slice(Math.max(0, endT - n + 1), endT + 1);
  const sw = m.storeWeeks[endT];
  view.appendChild(h('div', { class: 'viewhead' },
    h('div', null, h('h2', null, 'Seddon store: takings vs wages'), h('p', null, 'Counter takings (inc GST) from the weekly sales sheet, and store wages by fortnight. Wages % is worked out the way the sheet does it: wages ÷ the fortnight’s takings ex GST.')),
    rangeControl()));
  const fnsAll = m.fortnights.filter((f) => f.periodEnd <= w.we);
  const lastF = [...fnsAll].reverse().find((f) => f.wagePct != null);
  const medianPct = (() => { const a = fnsAll.filter((f) => f.wagePct != null).map((f) => f.wagePct).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; })();
  view.appendChild(h('div', { class: 'tiles four' },
    tile('Takings this week', sw ? money(sw.sales) : '—', sw ? `Discounts ${money(sw.discounts)}` : ''),
    tile('Same week last year', sw?.lastYear ? money(sw.lastYear) : '—', '', sw?.lastYear ? delta(sw.sales, sw.lastYear, { label: 'this year' }) : null),
    tile('12-week average', sw?.avg12 ? money(sw.avg12) : '—', 'Rolling, to this week'),
    tile('Latest wages %', lastF ? pct(lastF.wagePct) : '—', lastF ? `Fortnight to ${fmtDate(lastF.periodEnd, { short: true })} · typical ${pct(medianPct)}` : 'No wage figures')));

  const c = chartBox('tall');
  view.appendChild(panel('', 'Weekly takings', 'Bars are each week; the dark bar is the week selected',
    legendHTML([{ label: 'Takings', color: '--bar' }, { label: '12-week average', color: '--ink', line: true }, { label: 'Same week last year', color: '--ink-3', line: true }]), c.box,
    tableToggle('Show the numbers', dataTable(['Week ending', 'Takings', 'Discounts', '12-wk average', 'Last year', 'Change'], sws.map((x) => ({ cls: x.we === w.we ? 'sel' : null, cells: [fmtDate(x.we), money(x.sales, 2), money(x.discounts, 2), x.avg12 ? money(x.avg12) : '—', x.lastYear ? money(x.lastYear, 2) : '—', x.lastYear ? signedPct(x.sales / x.lastYear - 1) : '—'] })).reverse()))));
  draw('st-weekly', c.canvas, () => ({
    labels: sws.map((x) => fmtDate(x.we, { short: true })), selectedIndex: sws.findIndex((x) => x.we === w.we), band: false,
    datasets: [
      { label: 'Takings', type: 'bar', neutral: true, data: sws.map((x) => x.sales) },
      { label: '12-week average', type: 'line', color: 'ink', data: sws.map((x) => (x.avg12 ? Math.round(x.avg12) : null)) },
      { label: 'Same week last year', type: 'line', color: 'ink3', thin: true, data: sws.map((x) => x.lastYear ?? null) },
    ],
    y: { fmt: (v, axis) => (axis ? moneyK(v) : money(v)) },
    onPick: (i) => { const ix = m.idxOf[sws[i].we]; if (ix != null) setWeek(ix); },
  }));

  const fns = m.fortnights.filter((f) => f.wagePct != null && f.periodEnd >= sws[0].we && f.periodEnd <= w.we);
  const c2 = chartBox();
  const ehOn = !!m.eh;
  view.appendChild(panel('', 'Wages as a share of takings', lastF && (new Date(w.we) - new Date(lastF.periodEnd)) / 864e5 > 14
    ? `No wage figures after ${fmtDate(lastF.periodEnd)}. ${ehOn ? 'Employment Hero sync is on — check its last run.' : 'Connect Employment Hero to fill this in automatically.'}`
    : 'By fortnight, ex GST', c2.box,
    tableToggle('Show the numbers', dataTable(['Fortnight', 'Takings', 'Ex GST', 'Wages', 'Wages %', 'Source'], m.fortnights.filter((f) => f.periodEnd <= w.we).slice().reverse().map((f) => ({ cells: [fmtRange(f.start, f.periodEnd), f.sales ? money(f.sales) : '—', f.exGst ? money(f.exGst) : '—', money(f.amount), f.wagePct != null ? pct(f.wagePct) : '—', f.source === 'eh' ? 'Employment Hero' : 'Sales sheet'] }))))));
  if (fns.length) draw('st-wages', c2.canvas, () => ({
    labels: fns.map((f) => fmtDate(f.periodEnd, { short: true })), selectedIndex: fns.length - 1, band: false,
    datasets: [{ label: 'Wages % of takings ex GST', type: 'bar', neutral: true, data: fns.map((f) => Math.round(f.wagePct * 1000) / 10), fmt: (v) => `${v}%` }],
    y: { fmt: (v) => `${v}%` },
    tipExtra: (i) => `${money(fns[i].amount)} wages · ${money(fns[i].exGst)} takings ex GST`,
  }));
  else c2.box.replaceWith(h('div', { class: 'empty' }, h('strong', null, 'No wage figures in this period'), h('span', null, 'The sales sheet has store wages up to July 2026. Employment Hero will supply them from here on.')));

  // Daily: takings typed in from Marissa's photos, alongside Employment Hero's wage cost for the same day.
  const byDate = new Map();
  for (const d of (S.data.daily || []).filter((x) => x.kind === 'takings')) byDate.set(d.date, { date: d.date, takings: (byDate.get(d.date)?.takings || 0) + (d.amount || 0), note: d.note || '' });
  for (const e of S.data.eh?.daily || []) byDate.set(e.date, { ...(byDate.get(e.date) || { date: e.date }), wages: e.cost, hours: e.hours });
  const days = [...byDate.values()].filter((d) => d.date <= w.we).sort((a, b) => a.date.localeCompare(b.date)).slice(-42);
  view.appendChild(panel('', 'Daily takings vs wages', days.length ? 'Last six weeks of days with figures' : null, days.length
    ? h('div', { class: 'scroll' }, dataTable(['Date', 'Takings', 'Wages', 'Hours', 'Wages %', 'Note'], days.reverse().map((d) => ({
      cells: [fmtDate(d.date, { weekday: true }), d.takings != null ? money(d.takings, 2) : '—', d.wages != null ? money(d.wages, 2) : '—', d.hours != null ? hrs(d.hours) : '—',
        d.takings && d.wages != null ? pct(d.wages / (d.takings / (1 + m.settings.gstRate))) : '—', d.note || ''],
    }))))
    : h('div', { class: 'empty' }, h('strong', null, 'Daily figures will show here'), h('span', null, 'Add a day’s takings (and Marissa’s photo of it) in Admin → Add a day. With Employment Hero connected, each day also shows that day’s wage cost.'))));
}

// ---------- MONTHLY REPORTS ----------
function months(view) {
  const m = S.model;
  if (!S.month || !m.months.find((x) => x.key === S.month)) S.month = W().month;
  const mo = m.months.find((x) => x.key === S.month) || m.months.at(-1);
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Month' });
  for (const x of [...m.months].reverse()) chips.appendChild(h('button', { type: 'button', 'aria-pressed': String(x.key === mo.key), onclick: () => { S.month = x.key; render(); } }, x.label));
  view.appendChild(h('div', { class: 'viewhead' }, h('div', null, h('h2', null, 'Monthly reports'), h('p', null, 'The same tables as the weekly email, with totals that add every week of the month.'))));
  view.appendChild(chips);

  const ws = mo.idxs.map((i) => m.weeks[i]);
  const tables = [];
  for (const s of staffList()) {
    const rows = ws.map((x) => x.staff[s.id]).filter(Boolean);
    if (!rows.length) continue;
    const t = mo.staffTotals[s.id];
    tables.push({ title: s.name, color: staffColor(s.id), head: ['Week ending', 'Total orders', 'Repairs revenue', 'Hours worked', 'Revenue per hour', 'Total of days'],
      rows: rows.map((r) => ({ we: r.we, cells: [fmtDate(r.we), int(r.orders), money(r.revenue, 2), String(r.hours), r.hours ? money(r.rph, 2) : '$0.00', String(r.days)], flags: issuesFor(r.we, s.id) })),
      total: ['TOTAL', int(t.orders), money(t.revenue, 2), String(t.hours), t.hours ? money(t.rph, 2) : '$0.00', String(t.days)] });
  }
  const iw = ws.filter((x) => x.intake);
  if (iw.length) tables.push({ title: 'Other stores', color: '--s3', head: ['Week ending', 'Total orders', 'Stores repair'],
    rows: iw.map((x) => ({ we: x.we, cells: [fmtDate(x.we), int(x.intake.orders), money(x.intake.revenue, 2)], flags: issuesFor(x.we, 'other').filter((i) => !i.staff) })),
    total: ['TOTAL', int(mo.intake.orders), money(mo.intake.revenue, 2)] });

  const sumLine = `${money(mo.done.revenue)} of repairs sewn in ${hrs(mo.done.hours)} (${mo.done.hours ? money(mo.done.rph, 2) : '—'}/h)`
    + (mo.intake ? ` · ${money(mo.intake.revenue)} sent in from other stores` : '')
    + (mo.takings ? ` · store takings ${money(mo.takings)}` : '');
  const copyBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Copy tables for email');
  copyBtn.addEventListener('click', () => copyTables(mo, tables));
  const reportPanel = panel('', mo.label, sumLine, h('div', { class: 'controls', style: { marginBottom: '14px' } }, copyBtn));
  for (const t of tables) {
    reportPanel.appendChild(h('div', { class: 'report' },
      h('h3', null, h('i', { class: 'key', style: { '--k': t.color.startsWith('--') ? `var(${t.color})` : t.color } }), t.title),
      h('div', { class: 'scroll', style: { marginTop: 0 } }, (() => {
        const tbl = dataTable(t.head, [...t.rows.map((r) => ({ cells: r.flags.length ? [r.cells[0], ...r.cells.slice(1, -1), h('span', null, r.cells.at(-1), flagMark(r.flags.map((f) => f.title).join('; ')))] : r.cells })), { cls: 'total', cells: t.total }]);
        return tbl;
      })())));
  }
  const monthIssues = (S.data.issues || []).filter((i) => i.we && i.we.startsWith(mo.key) || i.sheet && sheetMonthKey(i.sheet) === mo.key);
  if (monthIssues.length) reportPanel.appendChild(h('p', { class: 'small', style: { marginTop: '14px' } }, h('span', { class: 'pill warn' }, `${plural(monthIssues.length, 'check')} for this month`), ' ', h('a', { href: '#checks' }, 'See data checks')));
  view.appendChild(reportPanel);

  // all months summary
  const head = ['Month', ...staffList().map((s) => `${s.name} $`), 'Sewn', 'Hours', '$/h', 'Sent in', 'Store takings', 'Wages %'];
  const rows = [...m.months].reverse().map((x) => {
    const fn = x.fortnights.filter((f) => f.wagePct != null);
    const wp = fn.length ? fn.reduce((s, f) => s + f.amount, 0) / fn.reduce((s, f) => s + f.exGst, 0) : null;
    return { cls: x.key === mo.key ? 'sel' : null, cells: [x.label, ...staffList().map((s) => (x.staffTotals[s.id] ? money(x.staffTotals[s.id].revenue) : '—')), money(x.done.revenue), hrs(x.done.hours), x.done.hours ? money(x.done.rph, 2) : '—', x.intake ? money(x.intake.revenue) : '—', x.takings ? money(x.takings) : '—', wp != null ? pct(wp) : '—'] };
  });
  view.appendChild(panel('', 'Every month at a glance', 'Wages % uses the fortnights that end in that month', h('div', { class: 'scroll' }, dataTable(head, rows))));
}
function sheetMonthKey(sheet) {
  const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const s = String(sheet).toLowerCase();
  const mi = names.findIndex((n) => s.startsWith(n));
  if (mi < 0) return null;
  const y = (s.match(/(20\d\d)/) || [])[1] || (mi >= 8 && !/2026/.test(s) && /2025/.test(s) ? '2025' : '2026');
  return `${y}-${String(mi + 1).padStart(2, '0')}`;
}

async function copyTables(mo, tables) {
  const cell = 'border:1px solid #000;padding:2px 8px;text-align:center;font-family:Aptos,Calibri,Arial,sans-serif;font-size:12pt;white-space:nowrap';
  let html = `<p style="font-family:Aptos,Calibri,Arial,sans-serif;font-size:12pt">Repairs vs revenue for Seddon — ${mo.label}</p>`;
  let text = `Repairs vs revenue for Seddon — ${mo.label}\n\n`;
  for (const t of tables) {
    html += `<table style="border-collapse:collapse;margin-bottom:12px"><tr><td style="${cell};font-weight:bold" colspan="${t.head.length}">${esc(t.title)}</td></tr>`;
    html += `<tr>${t.head.map((x) => `<td style="${cell};font-weight:bold">${esc(x)}</td>`).join('')}</tr>`;
    for (const r of t.rows) html += `<tr>${r.cells.map((x) => `<td style="${cell}">${esc(x)}</td>`).join('')}</tr>`;
    html += `<tr>${t.total.map((x) => `<td style="${cell};font-weight:bold">${esc(x)}</td>`).join('')}</tr></table>`;
    text += `${t.title}\n${t.head.join('\t')}\n${t.rows.map((r) => r.cells.join('\t')).join('\n')}\n${t.total.join('\t')}\n\n`;
  }
  try {
    if (window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
    } else await navigator.clipboard.writeText(text);
    toast('Copied — paste into the email');
  } catch {
    try { await navigator.clipboard.writeText(text); toast('Copied as plain text'); } catch { toast('Copy isn’t allowed here — select the tables and copy them instead'); }
  }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- PHOTOS ----------
function photos(view) {
  const list = [...(S.data.photos || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  view.appendChild(h('div', { class: 'viewhead' }, h('div', null, h('h2', null, 'Photos'), h('p', null, 'Marissa’s photos of the repair dockets and takings, filed by the week they belong to.'))));
  if (!list.length) {
    view.appendChild(h('div', { class: 'empty' },
      h('strong', null, 'No photos added yet'),
      h('span', null, 'Add them in Admin → Photos: pick the photos, choose the day they’re from, and publish. They’re encrypted with the same passphrase as the figures.')));
    return;
  }
  const byWeek = new Map();
  for (const p of list) { const k = p.we || p.date; if (!byWeek.has(k)) byWeek.set(k, []); byWeek.get(k).push(p); }
  for (const [we, ps] of byWeek) {
    const g = h('div', { class: 'gallery' });
    for (const p of ps) {
      const img = h('img', { alt: p.caption || `Photo from ${fmtDate(p.date)}`, loading: 'lazy' });
      const btn = h('button', { type: 'button', 'aria-label': `Open photo from ${fmtDate(p.date)}` }, img);
      btn.addEventListener('click', () => openPhoto(p));
      g.appendChild(h('figure', null, btn, h('figcaption', null, `${fmtDate(p.date, { short: true })}${p.caption ? ` · ${p.caption}` : ''}`)));
      loadPhoto(p, true).then((url) => { if (url) img.src = url; });
    }
    view.appendChild(panel('', `Week ending ${fmtDate(we)}`, plural(ps.length, 'photo'), g));
  }
}
async function loadPhoto(p, thumb) {
  const path = thumb && p.thumb ? p.thumb : p.file;
  const cacheKey = path;
  if (S.photoCache.has(cacheKey)) return S.photoCache.get(cacheKey);
  try {
    const r = await fetch(path);
    if (!r.ok) return null;
    let bytes = new Uint8Array(await r.arrayBuffer());
    if (p.encrypted !== false && S.key) bytes = await decryptBytes(bytes, S.key);
    const url = URL.createObjectURL(new Blob([bytes], { type: p.mime || 'image/jpeg' }));
    S.photoCache.set(cacheKey, url);
    return url;
  } catch { return null; }
}
async function openPhoto(p) {
  const img = h('img', { alt: p.caption || '' });
  const close = h('button', { type: 'button' }, 'Close');
  const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo' }, close, h('div', null, img, h('p', { class: 'cap' }, `${fmtDate(p.date, { weekday: true })}${p.caption ? ` — ${p.caption}` : ''}`)));
  const done = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') done(); };
  close.addEventListener('click', done);
  box.addEventListener('click', (e) => { if (e.target === box) done(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
  close.focus();
  img.src = (await loadPhoto(p, false)) || '';
}

// ---------- DATA CHECKS ----------
function checks(view) {
  const iss = S.data.issues || [];
  const open = iss.filter((i) => !i.fixed);
  const fixed = iss.filter((i) => i.fixed);
  view.appendChild(h('div', { class: 'viewhead' }, h('div', null, h('h2', null, 'Data checks'), h('p', null, 'Every figure was read from the source files and checked. Anything the dashboard corrected is listed, and anything it couldn’t decide on is flagged for checking against Marissa’s photos.'))));
  const list = (items) => {
    const ul = h('ul', { class: 'checks' });
    for (const i of items) ul.appendChild(h('li', null,
      h('span', { class: `flag`, style: { width: '20px', height: '20px', marginLeft: 0, background: i.fixed ? 'var(--wash)' : null, color: i.fixed ? 'var(--ink-2)' : null } }, i.fixed ? '✓' : '!'),
      h('div', null, h('div', { class: 't' }, i.title), h('div', { class: 'd' }, i.detail)),
      h('div', { class: 'where' }, i.cell || i.sheet || '', i.we ? h('div', null, `W/E ${fmtDate(i.we, { short: true })}`) : null)));
    return ul;
  };
  view.appendChild(h('div', { class: 'grid' },
    panel('span-6', `To check (${open.length})`, 'Can’t be fixed without the original dockets', open.length ? list(open) : h('p', { class: 'muted' }, 'Nothing to check.')),
    panel('span-6', `Corrected automatically (${fixed.length})`, 'The dashboard already uses the corrected figure', list(fixed))));
  const src = h('dl', { class: 'kv stack' });
  for (const s of S.data.sources || []) src.append(h('dt', null, s.name), h('dd', null, `${s.what}. ${fmtDate(s.from)} – ${fmtDate(s.to)}. Imported ${new Date(s.importedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Melbourne' })}.`));
  if (S.data.eh?.syncedAt) src.append(h('dt', null, 'Employment Hero'), h('dd', null, `Wages and hours, synced ${new Date(S.data.eh.syncedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Melbourne' })}.`));
  const gl = h('dl', { class: 'kv' });
  for (const [k, v] of [
    ['Repairs done', 'Repairs revenue recorded for Serin and Lily that week (inc GST).'],
    ['Per repair hour', 'Repairs revenue ÷ sewing hours. Serin’s hours are her repair hours, excluding shop cover.'],
    ['In from other stores', 'The weekly total of repairs from the other stores, from the workbook’s Other Stores table.'],
    ['Behind or ahead', 'Work sent in over the last 8 weeks minus the work done in the week after each one.'],
    ['Repair wages', 'Employment Hero cost when connected; otherwise hours × pay rate + on-costs (super).'],
    ['Store wages %', 'Fortnight wages ÷ (two weeks’ takings ÷ 1.1), as in the Average Weekly Sales sheet.'],
  ]) gl.append(h('dt', null, k), h('dd', null, v));
  view.appendChild(h('div', { class: 'grid' }, panel('span-6', 'Where the figures come from', null, src), panel('span-6', 'How each number is worked out', null, gl)));
}

// ---------- footer ----------
function renderFoot() {
  const f = $('#foot');
  f.textContent = '';
  const upd = S.data.updatedAt ? new Date(S.data.updatedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Melbourne' }) : '—';
  f.append(
    h('span', null, `Figures updated ${upd} (Melbourne time)`, S.data.eh?.syncedAt ? ` · Employment Hero synced ${new Date(S.data.eh.syncedAt).toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne' })}` : ''),
    h('span', null, S.mode === 'vault' ? h('span', null, h('a', { href: 'admin.html' }, 'Admin'), ' · ', h('button', { type: 'button', class: 'linkbtn', onclick: lockAgain }, 'Lock')) : 'Private preview'));
}
function lockAgain() {
  try { sessionStorage.removeItem('seddon.key'); localStorage.removeItem('seddon.key'); } catch { /* ignore */ }
  location.reload();
}

boot().catch((e) => { const b = $('#boot'); b.hidden = false; b.textContent = `Something went wrong loading the dashboard: ${e.message}`; });
