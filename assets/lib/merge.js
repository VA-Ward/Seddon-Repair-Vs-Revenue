// Folding new figures into the stored data. Pure functions so they can be tested in Node.
import { sundayOnOrAfter, addDays, isSunday } from './dates.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const same = (a, b, keys) => keys.every((k) => (a[k] ?? null) === (b[k] ?? null));
let seq = 0;
const newId = (p) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function renumberIssues(issues) {
  return issues.map((i, n) => ({ ...i, id: `chk-${n + 1}` }));
}

/** Workbook import: rows in the file replace the same week/person; rows not in the file are kept. */
export function mergeRepairsImport(data, parsed, fileName = 'Seddon Repairs vs Revenue.xlsx') {
  const out = clone(data);
  const summary = { added: 0, changed: 0, unchanged: 0, kept: 0, newStaff: [], changedRows: [], from: null, to: null };
  const known = new Set(out.staff.map((s) => s.id));
  for (const s of parsed.staff) {
    if (!known.has(s.id)) {
      out.staff.push({ id: s.id, name: s.name, aliases: [], hoursPerDay: 5, maxDays: 5, payRate: null, ehName: '' });
      summary.newStaff.push(s.name);
    }
  }
  const key = (r) => `${r.staff}|${r.we}`;
  const existing = new Map(out.repairs.map((r) => [key(r), r]));
  const incoming = new Map(parsed.repairs.map((r) => [key(r), r]));
  const fields = ['orders', 'revenue', 'hours', 'days'];
  for (const [k, r] of incoming) {
    const old = existing.get(k);
    if (!old) summary.added++;
    else if (same(old, r, fields)) summary.unchanged++;
    else { summary.changed++; summary.changedRows.push({ we: r.we, staff: r.staff, before: pick(old, fields), after: pick(r, fields) }); }
  }
  for (const [k] of existing) if (!incoming.has(k)) summary.kept++;
  const merged = new Map(existing);
  for (const [k, r] of incoming) merged.set(k, r);
  out.repairs = [...merged.values()].sort((a, b) => a.we.localeCompare(b.we) || a.staff.localeCompare(b.staff));

  const oExisting = new Map(out.otherStores.map((r) => [r.we, r]));
  for (const r of parsed.otherStores) {
    const old = oExisting.get(r.we);
    if (!old) summary.added++;
    else if (same(old, r, ['orders', 'revenue'])) summary.unchanged++;
    else { summary.changed++; summary.changedRows.push({ we: r.we, staff: 'other', before: pick(old, ['orders', 'revenue']), after: pick(r, ['orders', 'revenue']) }); }
    oExisting.set(r.we, r);
  }
  out.otherStores = [...oExisting.values()].sort((a, b) => a.we.localeCompare(b.we));

  out.issues = renumberIssues([...parsed.issues.map((i) => ({ ...i, source: 'repairs' })), ...(out.issues || []).filter((i) => i.source !== 'repairs')]);
  const weeks = parsed.repairs.map((r) => r.we).sort();
  summary.from = weeks[0]; summary.to = weeks.at(-1);
  upsertSource(out, { name: fileName, what: 'Serin, Lily and other-stores repairs by week', from: summary.from, to: summary.to });
  out.updatedAt = new Date().toISOString();
  return { data: out, summary, issues: parsed.issues.length };
}

/** Sales sheet import: weekly takings + fortnightly wages for Seddon. */
export function mergeSalesImport(data, parsed, fileName = 'Average Weekly Sales - All Stores.xlsx') {
  const out = clone(data);
  const summary = { added: 0, changed: 0, unchanged: 0, wagesAdded: 0, wagesChanged: 0, from: null, to: null };
  const t = new Map((out.takings || []).map((r) => [r.we, r]));
  for (const r of parsed.takings) {
    const old = t.get(r.we);
    if (!old) summary.added++; else if (same(old, r, ['sales', 'discounts'])) summary.unchanged++; else summary.changed++;
    t.set(r.we, r);
  }
  out.takings = [...t.values()].sort((a, b) => a.we.localeCompare(b.we));
  const w = new Map((out.wages || []).map((r) => [r.periodEnd, r]));
  for (const r of parsed.wages) {
    const old = w.get(r.periodEnd);
    if (!old) summary.wagesAdded++; else if (old.amount !== r.amount) summary.wagesChanged++;
    w.set(r.periodEnd, r);
  }
  out.wages = [...w.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  out.issues = renumberIssues([...(out.issues || []).filter((i) => i.source !== 'sales'), ...parsed.issues.map((i) => ({ ...i, source: 'sales' }))]);
  summary.from = parsed.takings[0]?.we; summary.to = parsed.takings.at(-1)?.we;
  upsertSource(out, { name: `${fileName} (${parsed.sheet} sheet)`, what: 'Seddon store takings by week and wages by fortnight', from: summary.from, to: summary.to });
  out.updatedAt = new Date().toISOString();
  return { data: out, summary };
}

/** One week typed in by hand. form: { we, staff: {id: {orders, revenue, hours, days}}, other: {orders, revenue}, takings: {sales, discounts} } */
export function addManualWeek(data, form) {
  if (!form.we || !isSunday(form.we)) throw new Error('The week ending date has to be a Sunday.');
  const out = clone(data);
  for (const [staff, v] of Object.entries(form.staff || {})) {
    if (v == null || [v.orders, v.revenue, v.hours, v.days].every((x) => x == null || x === '')) continue;
    out.repairs = out.repairs.filter((r) => !(r.we === form.we && r.staff === staff));
    out.repairs.push({ we: form.we, staff, orders: +v.orders || 0, revenue: +v.revenue || 0, hours: +v.hours || 0, days: +v.days || 0, src: 'Admin' });
  }
  if (form.other && (form.other.orders !== '' || form.other.revenue !== '')) {
    out.otherStores = out.otherStores.filter((r) => r.we !== form.we);
    out.otherStores.push({ we: form.we, orders: +form.other.orders || 0, revenue: +form.other.revenue || 0, src: 'Admin' });
  }
  if (form.takings && form.takings.sales !== '' && form.takings.sales != null) {
    out.takings = (out.takings || []).filter((r) => r.we !== form.we);
    out.takings.push({ we: form.we, sales: +form.takings.sales || 0, discounts: +form.takings.discounts || 0, src: 'Admin' });
  }
  out.repairs.sort((a, b) => a.we.localeCompare(b.we) || a.staff.localeCompare(b.staff));
  out.otherStores.sort((a, b) => a.we.localeCompare(b.we));
  out.takings.sort((a, b) => a.we.localeCompare(b.we));
  out.updatedAt = new Date().toISOString();
  return out;
}

/** A single day's figure (from Marissa's photo). entry: { date, kind: 'takings'|'repairs', staff?, orders?, amount, note, photoIds? } */
export function addDaily(data, entry) {
  if (!entry.date) throw new Error('Pick the date.');
  const out = clone(data);
  out.daily = out.daily || [];
  out.daily.push({ id: newId('day'), we: sundayOnOrAfter(entry.date), ...entry, amount: entry.amount === '' ? null : +entry.amount, orders: entry.orders === '' || entry.orders == null ? null : +entry.orders });
  out.daily.sort((a, b) => a.date.localeCompare(b.date));
  out.updatedAt = new Date().toISOString();
  return out;
}

export function addPhotos(data, photos) {
  const out = clone(data);
  out.photos = [...(out.photos || []), ...photos.map((p) => ({ ...p, we: sundayOnOrAfter(p.date) }))].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  out.updatedAt = new Date().toISOString();
  return out;
}

export function removePhoto(data, id) {
  const out = clone(data);
  const p = (out.photos || []).find((x) => x.id === id);
  out.photos = (out.photos || []).filter((x) => x.id !== id);
  out.updatedAt = new Date().toISOString();
  return { data: out, files: p ? [p.file, p.thumb].filter(Boolean) : [] };
}

/** Before publishing, take the latest Employment Hero block from the copy on GitHub (only the sync job writes it). */
export function keepRemoteEh(local, remote) {
  if (!remote?.eh) return local;
  if (!local.eh || (remote.eh.syncedAt || '') > (local.eh.syncedAt || '')) return { ...local, eh: remote.eh };
  return local;
}

function upsertSource(out, src) {
  out.sources = (out.sources || []).filter((s) => !s.name.startsWith(src.name.split(' (')[0]));
  out.sources.push({ ...src, importedAt: new Date().toISOString() });
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

export { newId, addDays };
