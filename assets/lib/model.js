// Turns the stored records into everything the dashboard shows:
// weekly rows, monthly roll-ups, wage cost, the roster forecast and the written insights.
// Pure functions - no DOM - so the same numbers can be checked from Node.

import { addDays, fmtDate, monthKey, fmtMonth } from './dates.js';
import { money, hrs, int, pct, signedPct, plural } from './format.js';

export const DEFAULT_SETTINGS = {
  onCostPct: 12,          // super + other on-costs added to an hourly rate
  gstRate: 0.10,          // takings and repair prices are GST-inclusive
  productivityWeeks: 8,   // recent worked weeks used for each seamstress's $ per hour
  backlogWeeks: 8,        // look-back for "work in vs work done"
  catchUpWeeks: 4,        // spread any backlog over this many weeks
  availabilityWeeks: 4,   // someone who worked in this many recent weeks is assumed available
  coverHoursPerDay: 5,    // hours in a day of cover from an extra seamstress
};

const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x || 0), 0);
const median = (arr) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const norm = (s) => String(s || '').trim().toLowerCase();

export function buildModel(data, overrides = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}), ...(overrides.settings || {}) };
  const staff = (data.staff || []).map((s, i) => ({
    priority: i + 1, hoursPerDay: 5, maxDays: 5, payRate: null, ehName: '', ...s, ...(overrides.staff?.[s.id] || {}),
  }));
  const staffById = Object.fromEntries(staff.map((s) => [s.id, s]));
  const eh = data.eh && Array.isArray(data.eh.weekly) ? data.eh : null;

  const ehWeek = (s, we) => {
    if (!eh) return null;
    const key = norm(s.ehName || s.name);
    const rows = eh.weekly.filter((r) => r.we === we && (norm(r.employee) === key || norm(r.employee).split(/\s+/)[0] === key));
    if (!rows.length) return null;
    return { cost: sum(rows, (r) => r.cost || 0), hours: sum(rows, (r) => r.hours || 0) };
  };

  // ---- weeks (repairs workroom) ----
  const weekKeys = [...new Set([...(data.repairs || []).map((r) => r.we), ...(data.otherStores || []).map((r) => r.we)])].sort();
  const takingsByWe = Object.fromEntries((data.takings || []).map((t) => [t.we, t]));
  const intakeByWe = Object.fromEntries((data.otherStores || []).map((t) => [t.we, t]));

  const weeks = weekKeys.map((we) => {
    const recs = (data.repairs || []).filter((r) => r.we === we);
    const st = {};
    for (const s of staff) {
      const r = recs.find((x) => x.staff === s.id);
      if (!r) continue;
      const e = ehWeek(s, we);
      let wage = null;
      if (e) wage = { cost: e.cost, source: 'eh' };
      else if (s.payRate && r.hours > 0) wage = { cost: r.hours * s.payRate * (1 + settings.onCostPct / 100), source: 'rate' };
      else if (r.hours === 0) wage = { cost: 0, source: 'none' };
      st[s.id] = { ...r, rph: r.hours > 0 ? r.revenue / r.hours : null, wage };
    }
    // records for people not in the staff list (new names in a future workbook)
    for (const r of recs) if (!st[r.staff]) st[r.staff] = { ...r, rph: r.hours > 0 ? r.revenue / r.hours : null, wage: null };
    const list = Object.values(st);
    const done = {
      orders: sum(list, (x) => x.orders || 0),
      revenue: sum(list, (x) => x.revenue || 0),
      hours: sum(list, (x) => x.hours || 0),
    };
    done.rph = done.hours > 0 ? done.revenue / done.hours : null;
    const working = list.filter((x) => x.hours > 0);
    done.wageKnown = working.length > 0 && working.every((x) => x.wage && x.wage.cost != null);
    done.wageCost = done.wageKnown ? sum(working, (x) => x.wage.cost) : null;
    const ex = done.revenue / (1 + settings.gstRate);
    done.wagePct = done.wageKnown && ex > 0 ? done.wageCost / ex : null;
    const intake = intakeByWe[we] ? { orders: intakeByWe[we].orders, revenue: intakeByWe[we].revenue, flags: intakeByWe[we].flags || [] } : null;
    const flags = [...list.flatMap((x) => x.flags || []), ...(intake?.flags || [])];
    return { we, start: addDays(we, -6), month: monthKey(we), staff: st, done, intake, takings: takingsByWe[we] || null, flags };
  });
  const idxOf = Object.fromEntries(weeks.map((w, i) => [w.we, i]));

  // ---- store takings + wages (Seddon store, from the weekly sales sheet / Employment Hero) ----
  const takings = [...(data.takings || [])].sort((a, b) => a.we.localeCompare(b.we));
  const tIdx = Object.fromEntries(takings.map((t, i) => [t.we, i]));
  const storeWeeks = takings.map((t, i) => {
    const last12 = takings.slice(Math.max(0, i - 11), i + 1);
    const ly = takingsByWe[addDays(t.we, -364)] || null;
    return { ...t, avg12: last12.length === 12 ? sum(last12, (x) => x.sales) / 12 : null, lastYear: ly ? ly.sales : null };
  });
  const wageRows = mergeWages(data.wages || [], eh);
  const fortnights = wageRows.map((w) => {
    const a = takingsByWe[w.periodEnd], b = takingsByWe[addDays(w.periodEnd, -7)];
    const sales = a && b ? a.sales + b.sales : null;
    const exGst = sales != null ? sales / (1 + settings.gstRate) : null;
    return { ...w, start: addDays(w.periodEnd, -13), sales, exGst, wagePct: exGst ? w.amount / exGst : null };
  }).sort((x, y) => x.periodEnd.localeCompare(y.periodEnd));

  const model = { data, settings, staff, staffById, weeks, idxOf, storeWeeks, tIdx, fortnights, eh };
  model.months = buildMonths(model);
  return model;
}

function mergeWages(sheetRows, eh) {
  const out = new Map();
  for (const w of sheetRows) out.set(w.periodEnd, { periodEnd: w.periodEnd, amount: w.amount, source: w.source || 'sheet' });
  // The sales sheet is David's record, so it wins; Employment Hero fills the fortnights it doesn't have.
  if (eh && Array.isArray(eh.fortnights)) for (const f of eh.fortnights) {
    if (f.amount > 0 && !out.has(f.periodEnd)) out.set(f.periodEnd, { periodEnd: f.periodEnd, amount: f.amount, hours: f.hours ?? null, source: 'eh' });
  }
  return [...out.values()];
}

// ---- productivity / availability -------------------------------------------------

export function productivity(model, idx, staffId, n = model.settings.productivityWeeks) {
  let rev = 0, h = 0, count = 0, last = null;
  for (let i = idx; i >= 0 && count < n; i--) {
    const s = model.weeks[i].staff[staffId];
    if (s && s.hours > 0) { rev += s.revenue; h += s.hours; count++; if (!last) last = model.weeks[i].we; }
  }
  if (!h) return null;
  return { rph: rev / h, weeks: count, lastWorked: last };
}

export function blendedProductivity(model, idx, n = model.settings.productivityWeeks) {
  let rev = 0, h = 0, count = 0;
  for (let i = idx; i >= 0 && count < n; i--) {
    const d = model.weeks[i].done;
    if (d.hours > 0) { rev += d.revenue; h += d.hours; count++; }
  }
  return h ? rev / h : null;
}

export function lastWorked(model, idx, staffId) {
  for (let i = idx; i >= 0; i--) { const s = model.weeks[i].staff[staffId]; if (s && s.hours > 0) return model.weeks[i].we; }
  return null;
}

function usualPattern(model, idx, s) {
  const days = [], hpd = [];
  let count = 0;
  for (let i = idx; i >= 0 && count < 8; i--) {
    const r = model.weeks[i].staff[s.id];
    if (r && r.hours > 0 && r.days > 0) { days.push(r.days); hpd.push(r.hours / r.days); count++; }
  }
  return { usualDays: Math.max(1, Math.round(median(days) || 3)), hoursPerDay: s.hoursPerDay || median(hpd) || 5 };
}

export function isAvailableByDefault(model, idx, staffId) {
  const n = model.settings.availabilityWeeks;
  for (let i = idx; i > idx - n && i >= 0; i--) { const r = model.weeks[i].staff[staffId]; if (r && r.hours > 0) return true; }
  return false;
}

// ---- backlog ---------------------------------------------------------------------

// Work that came in over the look-back (weeks idx-n .. idx-1) against work done the week after (idx-n+1 .. idx).
export function backlogAt(model, idx, n = model.settings.backlogWeeks) {
  let inn = 0, done = 0, count = 0;
  for (let k = 0; k < n; k++) {
    const iIn = idx - 1 - k, iDone = idx - k;
    if (iIn < 0 || !model.weeks[iIn].intake) break;
    inn += model.weeks[iIn].intake.revenue;
    done += model.weeks[iDone].done.revenue;
    count++;
  }
  if (!count) return null;
  return { intake: inn, done, gap: inn - done, weeks: count, from: model.weeks[idx - count].we, to: model.weeks[idx].we };
}

// ---- roster forecast ------------------------------------------------------------

/**
 * Hours to roster for the week after `idx`, from the repairs taken in during week `idx`.
 * opts.available: { staffId: bool }   opts.catchUp: bool   opts.extraWork: $ to add (e.g. a big job)
 */
export function forecast(model, idx, opts = {}) {
  const W = model.weeks[idx];
  if (!W) return { ok: false, reason: 'No data for that week.' };
  if (!W.intake) return { ok: false, reason: `There's no "other stores" repairs figure for the week ending ${fmtDate(W.we)} yet, so there's nothing to forecast from.` };
  const st = model.settings;
  const blended = blendedProductivity(model, idx) || 60;
  const bl = backlogAt(model, idx);
  const catchUpOn = opts.catchUp !== false;
  const backlog = Math.max(0, bl?.gap || 0);
  const catchUp = catchUpOn ? backlog / st.catchUpWeeks : 0;
  const extra = opts.extraWork || 0;
  const work = W.intake.revenue + catchUp + extra;

  const people = model.staff.map((s) => {
    const p = productivity(model, idx, s.id);
    const pat = usualPattern(model, idx, s);
    const available = opts.available?.[s.id] ?? isAvailableByDefault(model, idx, s.id);
    return {
      id: s.id, name: s.name, available, priority: s.priority,
      rph: p ? p.rph : blended, rphWeeks: p ? p.weeks : 0, lastWorked: lastWorked(model, idx, s.id),
      usualDays: pat.usualDays, hoursPerDay: pat.hoursPerDay, maxDays: s.maxDays || 5, days: 0,
    };
  }).sort((a, b) => a.priority - b.priority);

  let remaining = work;
  const perDay = (p) => p.rph * p.hoursPerDay;
  const startWork = work;
  // Pass 1: usual days. Pass 2: extra days up to each person's max.
  for (const cap of ['usualDays', 'maxDays']) {
    for (const p of people.filter((x) => x.available)) {
      if (remaining <= 0.5) break;
      const room = Math.max(0, p[cap] - p.days);
      if (!room) continue;
      const need = Math.ceil(remaining / perDay(p) - 0.15); // a sliver of a day doesn't justify a whole one
      const add = Math.min(room, Math.max(need, 0));
      p.days += add;
      remaining -= add * perDay(p);
    }
  }
  // Exact hours the work needs (before rounding to whole days): fill people in order at their own rate.
  let left = startWork, neededHours = 0;
  for (const p of people) {
    p.hours = p.days * p.hoursPerDay; p.capacity = p.hours * p.rph; p.extraDays = Math.max(0, p.days - p.usualDays);
    const take = Math.min(left, p.capacity);
    p.workCovered = take; neededHours += take / p.rph; left -= take;
  }
  const coverRph = median(people.map((p) => p.rph)) || blended;
  const coverHours = left > 0.5 ? left / coverRph : 0;
  neededHours += coverHours;
  const coverDays = coverHours > 0 ? Math.ceil(coverHours / st.coverHoursPerDay - 0.15) : 0;
  const cover = { hours: coverHours, days: coverDays, rph: coverRph, rosterHours: coverDays * st.coverHoursPerDay, work: Math.max(0, left) };
  const rosterHours = sum(people, (p) => p.hours) + cover.rosterHours;

  // Indicative week after: next intake unknown, so use the 4-week average intake.
  const recent = model.weeks.slice(Math.max(0, idx - 3), idx + 1).filter((w) => w.intake);
  const avgIntake = recent.length ? sum(recent, (w) => w.intake.revenue) / recent.length : W.intake.revenue;
  const backlogAfter = Math.max(0, backlog - catchUp);
  const work2 = avgIntake + (catchUpOn ? backlogAfter / Math.max(1, st.catchUpWeeks - 1) : 0);
  const indicative = { forWe: addDays(W.we, 14), work: work2, hours: work2 / blended, avgIntake };

  return {
    ok: true, basedOnWe: W.we, forWe: addDays(W.we, 7), intake: W.intake, backlog: bl, backlogPositive: backlog,
    catchUp, catchUpOn, extra, work, blended, neededHours, people, cover, rosterHours,
    lastWeekHours: W.done.hours, indicative,
  };
}

// Hours that would have kept up with each week's incoming work, next to what was rostered.
export function historyNeededVsRostered(model) {
  const out = [];
  for (let i = 1; i < model.weeks.length; i++) {
    const prev = model.weeks[i - 1];
    if (!prev.intake) continue;
    const w = model.weeks[i];
    let h = 0, hr = 0;
    for (const [id, r] of Object.entries(w.staff)) {
      if (!(r.hours > 0)) continue;
      const p = productivity(model, i - 1, id);
      if (!p) continue;
      h += r.hours; hr += r.hours * p.rph;
    }
    const rate = h > 0 ? hr / h : blendedProductivity(model, i - 1);
    if (!rate) continue;
    out.push({ we: w.we, needed: prev.intake.revenue / rate, rostered: w.done.hours, intake: prev.intake.revenue, done: w.done.revenue, rate });
  }
  return out;
}

export function runningGap(model) {
  const out = [];
  for (let i = 1; i < model.weeks.length; i++) {
    const b = backlogAt(model, i);
    if (b && b.weeks >= Math.min(4, model.settings.backlogWeeks)) out.push({ we: model.weeks[i].we, gap: b.gap, weeks: b.weeks });
  }
  return out;
}

// ---- months ------------------------------------------------------------------------

function buildMonths(model) {
  const byKey = new Map();
  model.weeks.forEach((w, i) => { if (!byKey.has(w.month)) byKey.set(w.month, []); byKey.get(w.month).push(i); });
  const months = [];
  for (const [key, idxs] of byKey) {
    const ws = idxs.map((i) => model.weeks[i]);
    const staffTotals = {};
    for (const s of model.staff) {
      const rows = ws.map((w) => w.staff[s.id]).filter(Boolean);
      if (!rows.length) continue;
      const t = { orders: sum(rows, (r) => r.orders), revenue: sum(rows, (r) => r.revenue), hours: sum(rows, (r) => r.hours), days: sum(rows, (r) => r.days) };
      t.rph = t.hours ? t.revenue / t.hours : null;
      const wk = rows.filter((r) => r.hours > 0);
      t.wageKnown = wk.length > 0 && wk.every((r) => r.wage && r.wage.cost != null);
      t.wageCost = t.wageKnown ? sum(wk, (r) => r.wage.cost) : null;
      staffTotals[s.id] = t;
    }
    const intakeRows = ws.filter((w) => w.intake);
    const intake = intakeRows.length ? { orders: sum(intakeRows, (w) => w.intake.orders), revenue: sum(intakeRows, (w) => w.intake.revenue) } : null;
    const done = { orders: sum(ws, (w) => w.done.orders), revenue: sum(ws, (w) => w.done.revenue), hours: sum(ws, (w) => w.done.hours) };
    done.rph = done.hours ? done.revenue / done.hours : null;
    const takingsRows = ws.filter((w) => w.takings);
    const takings = takingsRows.length ? sum(takingsRows, (w) => w.takings.sales) : null;
    const fns = model.fortnights.filter((f) => monthKey(f.periodEnd) === key);
    months.push({ key, label: fmtMonth(key), idxs, staffTotals, intake, done, takings, fortnights: fns });
  }
  return months.sort((a, b) => a.key.localeCompare(b.key));
}

// ---- written insights -------------------------------------------------------------

export function insights(model, idx) {
  const out = [];
  const W = model.weeks[idx];
  if (!W) return out;
  const st = model.settings;
  const b12 = blendedProductivity(model, idx);
  const d = W.done;

  // 1. Work done, and each person's $ per hour against their own recent average
  if (d.hours > 0) {
    const who = model.staff.filter((s) => W.staff[s.id]?.hours > 0);
    out.push({ tone: 'info', text: `${joinNames(who.map((s) => s.name))} completed ${money(d.revenue)} of repairs (${int(d.orders)} orders) in ${hrs(d.hours)} — ${money(d.rph, 2)} an hour.` });
    for (const s of who) {
      const r = W.staff[s.id];
      const p = productivity(model, idx - 1, s.id);
      if (!p || p.weeks < 4) continue;
      const vs = r.rph / p.rph - 1;
      if (Math.abs(vs) < 0.08) continue;
      out.push({ tone: vs < 0 ? 'warn' : 'good', text: `${s.name}'s ${money(r.rph, 2)} an hour is ${Math.abs(Math.round(vs * 100))}% ${vs < 0 ? 'below' : 'above'} her average of ${money(p.rph, 2)} over the previous ${p.weeks} weeks she worked.` });
    }
  } else {
    out.push({ tone: 'warn', text: 'No repair hours were recorded this week.' });
  }

  // 2. Work coming in vs work done
  const bl = backlogAt(model, idx);
  if (W.intake) {
    let t = `Other stores sent in ${money(W.intake.revenue)} of repairs (${int(W.intake.orders)} orders).`;
    if (bl && bl.weeks >= 4) {
      const rph = b12 || 60;
      if (bl.gap > 300) t += ` Over the last ${bl.weeks} weeks ${money(bl.intake)} came in and ${money(bl.done)} was done the following week — about ${money(bl.gap)} behind, or roughly ${hrs(bl.gap / rph)} of sewing.`;
      else if (bl.gap < -300) t += ` Over the last ${bl.weeks} weeks the workroom finished ${money(-bl.gap)} more than came in, so it's ahead of the intake.`;
      else t += ` Over the last ${bl.weeks} weeks, work done has kept pace with what came in.`;
      out.push({ tone: bl.gap > 300 ? 'warn' : 'good', text: t });
    } else out.push({ tone: 'info', text: t });
  }

  // 3. Staff changes
  for (const s of model.staff) {
    const r = W.staff[s.id];
    if (r && r.hours > 0) continue;
    const lw = lastWorked(model, idx, s.id);
    if (lw && lw !== W.we) {
      const gapWeeks = Math.round((new Date(W.we) - new Date(lw)) / 6048e5);
      if (gapWeeks <= 26) out.push({ tone: gapWeeks >= 4 ? 'warn' : 'info', text: `${s.name} didn't work this week${gapWeeks > 1 ? ` — last worked the week ending ${fmtDate(lw)} (${plural(gapWeeks, 'week')} ago)` : ''}.` });
    }
  }

  // 4. Wages vs repairs revenue
  if (d.hours > 0) {
    if (d.wageKnown) {
      const src = model.staff.some((s) => W.staff[s.id]?.wage?.source === 'eh') ? 'from Employment Hero' : 'estimated from pay rates';
      out.push({ tone: d.wagePct > 0.6 ? 'warn' : 'good', text: `Repair wages ${src}: ${money(d.wageCost)}, which is ${pct(d.wagePct)} of repairs revenue (ex GST).` });
    } else {
      out.push({ tone: 'info', text: 'Wage cost for the seamstresses will show once their pay rates are added or Employment Hero is connected.', action: 'rates' });
    }
  }

  // 5. Store takings
  const sw = model.storeWeeks[model.tIdx[W.we]];
  if (sw) {
    let t = `Seddon store took ${money(sw.sales)} this week`;
    const parts = [];
    if (sw.lastYear) parts.push(`${signedPct(sw.sales / sw.lastYear - 1)} on the same week last year (${money(sw.lastYear)})`);
    if (sw.avg12) parts.push(`12-week average ${money(sw.avg12)}`);
    t += parts.length ? ` — ${parts.join('; ')}.` : '.';
    out.push({ tone: 'info', text: t });
  }
  const lastF = [...model.fortnights].filter((f) => f.wagePct != null && f.periodEnd <= W.we).pop();
  if (lastF) {
    const stale = (new Date(W.we) - new Date(lastF.periodEnd)) / 864e5;
    if (stale > 14) out.push({ tone: 'warn', text: `Store wage figures stop at the fortnight ending ${fmtDate(lastF.periodEnd)} (${pct(lastF.wagePct)} of takings ex GST). Connecting Employment Hero fills the gap automatically.`, action: 'eh' });
    else out.push({ tone: lastF.wagePct > 0.6 ? 'warn' : 'info', text: `Store wages for the fortnight ending ${fmtDate(lastF.periodEnd)}: ${money(lastF.amount)}, ${pct(lastF.wagePct)} of takings ex GST.` });
  }

  // 6. Data checks touching this week
  const iss = (model.data.issues || []).filter((i) => i.we === W.we && !i.fixed);
  if (iss.length) out.push({ tone: 'warn', text: `${plural(iss.length, 'figure')} for this week ${iss.length === 1 ? 'needs' : 'need'} checking against Marissa's photos (see Data checks).`, action: 'checks' });
  return out;
}

function joinNames(names) {
  if (!names.length) return 'The workroom';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
