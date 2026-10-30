// Workbook parsers shared by the Admin page (browser) and the import scripts (Node).
// They take a SheetJS workbook, so the same code reads the file either way.
//
//  parseRepairsWorkbook  -> "Seddon Repairs vs Revenue.xlsx" (one sheet per month,
//                           a block per seamstress + an "Other Stores" block)
//  parseSalesWorkbook    -> "Average Weekly Sales - All Stores.xlsx" (SEDDON sheet:
//                           weekly takings + fortnightly wages)
//
// Every correction is recorded as an issue, so nothing is changed silently.

import { ymd, toISO, addDays, diffDays, isSunday, fmtDate, excelSerialToISO } from './dates.js';

const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

export function parseMoney(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s === '' || s === '-' || s === '$-' || s === '$ -') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s) || /\$\s*\(.*\)/.test(s)) neg = true;
  if (s.startsWith('-')) neg = true;
  s = s.replace(/[^0-9.]/g, '');
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function parseNum(v) {
  if (typeof v === 'number') return v;
  if (isBlank(v)) return null;
  return parseMoney(v);
}

// ---- dates -------------------------------------------------------------------

function dateCandidates(v) {
  // Returns [{iso, how}] for a "week ending" cell.
  if (v instanceof Date) return [{ iso: toISO(ymd(v.getFullYear(), v.getMonth() + 1, v.getDate())), how: 'date' }];
  if (typeof v === 'number' && v > 20000 && v < 80000) return [{ iso: excelSerialToISO(v), how: 'serial' }];
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{1,2})[./\-](\d{1,2})[./\-](\d{2,4})$/);
  if (!m) return [];
  const a = +m[1], b = +m[2];
  let y = +m[3];
  if (y < 100) y += 2000;
  const out = [];
  const mdy = ymd(y, a, b); if (mdy) out.push({ iso: toISO(mdy), how: 'mdy', y, mo: a, d: b });
  const dmy = ymd(y, b, a); if (dmy && !(a === b)) out.push({ iso: toISO(dmy), how: 'dmy', y, mo: b, d: a });
  return out;
}

// Pick the date for a "week ending" cell. `expected` is the previous row + 7 days.
export function resolveWeekEnding(raw, expected) {
  const cands = dateCandidates(raw);
  if (expected) {
    const exact = cands.find((c) => c.iso === expected);
    if (exact) return { iso: expected, fix: null };
    // Year typo, e.g. 04.12.27 where 04.12.26 was meant.
    const ey = +expected.slice(0, 4);
    for (const c of cands) {
      if (!c.mo) continue;
      const fixed = ymd(ey, c.mo, c.d);
      if (fixed && toISO(fixed) === expected) return { iso: expected, fix: 'year' };
    }
    const sunday = cands.find((c) => isSunday(c.iso) && Math.abs(diffDays(c.iso, expected)) <= 35);
    if (sunday) return { iso: sunday.iso, fix: sunday.iso === expected ? null : 'gap' };
    return { iso: expected, fix: 'assumed' };
  }
  const sun = cands.find((c) => c.how === 'mdy' && isSunday(c.iso)) || cands.find((c) => isSunday(c.iso));
  if (sun) return { iso: sun.iso, fix: null };
  if (cands[0]) return { iso: cands[0].iso, fix: 'not-sunday' };
  return { iso: null, fix: 'unreadable' };
}

// ---- repairs workbook --------------------------------------------------------

const COLS = [
  { key: 'week', test: (h) => h === 'week ending' || h === 'week end' || h === 'w/e' },
  { key: 'orders', test: (h) => h.includes('orders') },
  { key: 'rph', test: (h) => h.includes('per hour') },
  { key: 'revenue', test: (h) => (h.includes('revenue') || h.includes('repair')) && !h.includes('per hour') },
  { key: 'hours', test: (h) => h.includes('hours') },
  { key: 'days', test: (h) => h.includes('days') },
];

function readBlock(rows, r, c) {
  const head = rows[r] || [];
  const map = {};
  for (let cc = c; cc < c + 8; cc++) {
    const h = norm(head[cc]);
    if (!h) break;
    if (cc > c && h === 'week ending') break;
    const def = COLS.find((d) => !(d.key in map) && d.test(h));
    if (def) map[def.key] = cc;
  }
  const items = [];
  let total = null;
  for (let rr = r + 1; rr < rows.length; rr++) {
    const row = rows[rr] || [];
    const w = row[c];
    if (isBlank(w)) {
      // A TOTAL row sometimes has no label in the first column (Sep 2025).
      const vals = Object.entries(map).filter(([k]) => k !== 'week').map(([, col]) => row[col]);
      if (vals.some((v) => typeof v === 'number')) total = { row: rr, values: pick(row, map) };
      break;
    }
    if (norm(w) === 'total') { total = { row: rr, values: pick(row, map) }; break; }
    if (!dateCandidates(w).length) break; // ran into the next block's title
    items.push({ row: rr, raw: w, values: pick(row, map) });
  }
  return { map, items, total };
}

function pick(row, map) {
  const o = {};
  for (const [k, col] of Object.entries(map)) o[k] = k === 'week' ? row[col] : parseNum(row[col]);
  return o;
}

const colLetter = (n) => { let s = ''; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const cellRef = (sheet, r, c) => `${sheet}!${colLetter(c)}${r + 1}`;

function slug(name) { return norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length];
}

/**
 * @param XLSX  SheetJS module
 * @param wb    workbook from XLSX.read / XLSX.readFile
 * @param opts  { staff: [{id, name, aliases}] } known staff, so name variants map to the right person
 */
export function parseRepairsWorkbook(XLSX, wb, opts = {}) {
  const issues = [];
  const known = (opts.staff || []).map((s) => ({ id: s.id, names: [s.name, ...(s.aliases || [])].map(norm) }));
  const staffSeen = new Map(); // id -> display name
  const repairs = [];
  const otherStores = [];
  let lastWeek = null; // global sequence across sheets
  const addIssue = (i) => issues.push({ severity: 'warn', ...i });

  const nameCounts = new Map(); // id -> Map(name -> count)
  const nameUses = []; // {id, raw, sheet}
  const resolveStaff = (title) => {
    const raw = String(title).split(/[-–(]/)[0].trim();
    const base = norm(raw);
    let hit = null;
    for (const k of known) if (k.names.includes(base)) { hit = { id: k.id, alias: k.names[0] !== base }; break; }
    if (!hit) for (const k of known) for (const n of k.names) if (editDistance(n, base) === 1) { hit = { id: k.id, alias: true }; break; }
    if (!hit) for (const [id] of staffSeen) if (editDistance(id, slug(base)) === 1) { hit = { id, alias: true }; break; }
    if (!hit) hit = { id: slug(base), alias: false };
    const counts = nameCounts.get(hit.id) || new Map();
    counts.set(raw, (counts.get(raw) || 0) + 1);
    nameCounts.set(hit.id, counts);
    return { ...hit, name: raw };
  };

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
    const blocks = [];
    rows.forEach((row, r) => (row || []).forEach((v, c) => { if (norm(v) === 'week ending') blocks.push({ r, c }); }));
    if (!blocks.length) continue;

    // Work out each block's identity first so a "repair only" block can override a plain one.
    const parsed = blocks.map(({ r, c }) => {
      const title = rows[r - 1]?.[c] ?? rows[r - 2]?.[c] ?? '';
      const t = norm(title);
      const kind = /other\s*store/.test(t) ? 'other' : 'staff';
      return { r, c, title: String(title).trim(), kind, repairOnly: /repair\s*only/.test(t), ...readBlock(rows, r, c) };
    });

    for (const b of parsed) {
      // Dates: each row is the week after the one above it; the first row follows on from the previous sheet.
      const expected = lastWeek ? addDays(lastWeek, 7) : null;
      const weeks = [];
      b.items.forEach((it, idx) => {
        const exp = idx === 0 ? expected : addDays(weeks[idx - 1], 7);
        const res = resolveWeekEnding(it.raw, exp);
        weeks.push(res.iso);
        it.iso = res.iso;
        it.dateFix = res.fix;
      });
      b.weeks = weeks;
    }

    // Report date corrections once per sheet row
    const reported = new Set();
    for (const b of parsed) for (const it of b.items) {
      if (!it.dateFix || reported.has(it.row)) continue;
      reported.add(it.row);
      const shown = String(it.raw);
      if (it.dateFix === 'year') addIssue({ code: 'date-year', severity: 'warn', sheet: sheetName, cell: cellRef(sheetName, it.row, b.c), we: it.iso, title: `Week ending typed as ${shown}`, detail: `Read as ${fmtDate(it.iso)} — the year doesn't follow on from the week before.`, fixed: true });
      else if (it.dateFix === 'gap') addIssue({ code: 'date-gap', severity: 'warn', sheet: sheetName, cell: cellRef(sheetName, it.row, b.c), we: it.iso, title: `A week is missing before ${fmtDate(it.iso)}`, detail: `The row above is more than 7 days earlier.` });
      else if (it.dateFix === 'assumed') addIssue({ code: 'date-assumed', severity: 'error', sheet: sheetName, cell: cellRef(sheetName, it.row, b.c), we: it.iso, title: `Couldn't read the date "${shown}"`, detail: `Treated as ${fmtDate(it.iso)} (7 days after the row above).`, fixed: true });
      else if (it.dateFix === 'not-sunday') addIssue({ code: 'date-not-sunday', severity: 'warn', sheet: sheetName, cell: cellRef(sheetName, it.row, b.c), we: it.iso, title: `Week ending ${shown} isn't a Sunday`, detail: 'Weeks normally end on a Sunday.' });
      else if (it.dateFix === 'unreadable') addIssue({ code: 'date-unreadable', severity: 'error', sheet: sheetName, cell: cellRef(sheetName, it.row, b.c), title: `Couldn't read the date "${shown}"`, detail: 'This row was skipped.' });
    }

    // Staff blocks: if a person has a "repair only" block on the sheet, its hours are the repair hours.
    const staffBlocks = parsed.filter((b) => b.kind === 'staff');
    const byPerson = new Map();
    for (const b of staffBlocks) {
      const who = resolveStaff(b.title);
      b.staffId = who.id;
      if (!staffSeen.has(who.id)) staffSeen.set(who.id, who.name.split(/[-–(]/)[0].trim());
      nameUses.push({ id: who.id, raw: who.name, sheet: sheetName });
      if (!byPerson.has(b.staffId)) byPerson.set(b.staffId, []);
      byPerson.get(b.staffId).push(b);
    }

    for (const [staffId, list] of byPerson) {
      const repairOnly = list.find((b) => b.repairOnly);
      const plain = list.find((b) => !b.repairOnly);
      const main = repairOnly || plain;
      if (repairOnly && plain) {
        addIssue({ code: 'repair-only-hours', severity: 'info', sheet: sheetName, staff: staffId, title: `${sheetName}: used the "repair only" hours`, detail: `The sheet has two tables for this person. The repair-only hours leave out shop cover, which matches how hours are recorded from October 2025.`, fixed: true });
      }
      main.items.forEach((it, idx) => {
        if (!it.iso) return;
        const v = it.values;
        const rec = {
          we: it.iso, staff: staffId,
          orders: v.orders ?? 0, revenue: v.revenue ?? 0, hours: v.hours ?? 0, days: v.days ?? 0,
          src: cellRef(sheetName, it.row, main.c),
        };
        if (repairOnly && plain) {
          const p = plain.items.find((x) => x.iso === it.iso);
          if (p && p.values.hours != null && p.values.hours !== rec.hours) rec.paidHours = p.values.hours;
        }
        // Revenue per hour cell check
        if (v.rph != null && rec.hours > 0) {
          const should = rec.revenue / rec.hours;
          if (Math.abs(v.rph - should) > 0.5) addIssue({ code: 'rph-formula', severity: 'warn', sheet: sheetName, cell: cellRef(sheetName, it.row, main.map.rph), we: it.iso, staff: staffId, title: `Revenue per hour shows $${v.rph.toFixed(2)}`, detail: `$${rec.revenue.toLocaleString('en-AU')} ÷ ${rec.hours} h = $${should.toFixed(2)}. The dashboard recalculates it.`, fixed: true });
        }
        if (rec.revenue > 0 && rec.hours === 0) addIssue({ code: 'revenue-no-hours', severity: 'warn', sheet: sheetName, we: it.iso, staff: staffId, title: 'Revenue recorded with no hours', detail: `$${rec.revenue} recorded but 0 hours worked.` });
        repairs.push(rec);
      });
      checkTotals(main, sheetName, staffId, issues, ['orders', 'revenue', 'hours', 'days']);
    }

    for (const b of parsed.filter((x) => x.kind === 'other')) {
      b.items.forEach((it) => {
        if (!it.iso) return;
        otherStores.push({ we: it.iso, orders: it.values.orders ?? 0, revenue: it.values.revenue ?? 0, src: cellRef(sheetName, it.row, b.c) });
      });
      checkTotals(b, sheetName, 'other', issues, ['orders', 'revenue']);
    }

    // Advance the global sequence to the last week on this sheet.
    const allWeeks = parsed.flatMap((b) => b.weeks).filter(Boolean).sort();
    if (allWeeks.length) lastWeek = allWeeks[allWeeks.length - 1];
  }

  // De-duplicate (a week can only appear once per person / once for other stores).
  const dedupe = (arr, keyFn, label) => {
    const seen = new Map();
    const out = [];
    for (const r of arr) {
      const k = keyFn(r);
      if (seen.has(k)) {
        issues.push({ code: 'duplicate-week', severity: 'error', we: r.we, title: `${label(r)} appears twice for ${fmtDate(r.we)}`, detail: `Kept ${seen.get(k).src}, ignored ${r.src}.` });
        continue;
      }
      seen.set(k, r); out.push(r);
    }
    return out;
  };
  const rep = dedupe(repairs, (r) => `${r.staff}|${r.we}`, (r) => r.staff);
  const oth = dedupe(otherStores, (r) => r.we, () => 'Other stores');

  flagRepeatedFigures(rep, oth, issues);
  flagOddOrderValues(rep, oth, issues);

  rep.sort((a, b) => a.we.localeCompare(b.we) || a.staff.localeCompare(b.staff));
  oth.sort((a, b) => a.we.localeCompare(b.we));

  const knownName = (id) => (opts.staff || []).find((s) => s.id === id)?.name;
  const commonName = (id) => [...(nameCounts.get(id) || new Map())].sort((a, b) => b[1] - a[1])[0]?.[0] || id;
  const tidy = (n) => n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
  // Without a staff list, key each person by the spelling used most often.
  const remap = new Map();
  if (!known.length) for (const id of staffSeen.keys()) { const want = slug(commonName(id)); if (want && want !== id) remap.set(id, want); }
  const finalId = (id) => remap.get(id) || id;
  for (const r of rep) r.staff = finalId(r.staff);
  for (const i of issues) if (i.staff) i.staff = finalId(i.staff);
  const staff = [...staffSeen.keys()].map((id) => ({ id: finalId(id), name: knownName(id) || tidy(commonName(id)) }));
  const nameOf = (id) => staff.find((s) => s.id === finalId(id))?.name || id;
  const flagged = new Set();
  for (const u of nameUses) {
    if (norm(u.raw) === norm(nameOf(u.id)) || flagged.has(u.sheet + u.id)) continue;
    flagged.add(u.sheet + u.id);
    issues.unshift({ code: 'name-variant', severity: 'info', sheet: u.sheet, staff: finalId(u.id), title: `"${u.raw}" on the ${u.sheet} sheet treated as ${nameOf(u.id)}`, detail: 'The name is spelt differently on this sheet.', fixed: true });
  }
  return { repairs: rep, otherStores: oth, staff, issues };
}

function checkTotals(block, sheetName, who, issues, keys) {
  if (!block.total) return;
  const label = who === 'other' ? 'Other stores' : who.charAt(0).toUpperCase() + who.slice(1);
  const n = block.items.length;
  for (const k of keys) {
    const shown = block.total.values[k];
    if (shown == null) continue;
    const sum = block.items.reduce((s, it) => s + (it.values[k] || 0), 0);
    if (Math.abs(sum - shown) < 0.01) continue;
    const sumShort = block.items.slice(0, -1).reduce((s, it) => s + (it.values[k] || 0), 0);
    const last = block.items[n - 1];
    const what = { orders: 'orders', revenue: 'revenue', hours: 'hours', days: 'days' }[k];
    if (n > 1 && Math.abs(sumShort - shown) < 0.01) {
      // Report once per block, not per column.
      if (issues.some((i) => i.code === 'total-short' && i.sheet === sheetName && i.who === who)) continue;
      issues.push({ code: 'total-short', severity: 'warn', sheet: sheetName, who, staff: who === 'other' ? undefined : who, we: last.iso, title: `${sheetName} TOTAL for ${label} leaves out the last week`, detail: `The TOTAL row adds ${n - 1} of ${n} weeks — week ending ${fmtDate(last.iso)} isn't included. The dashboard adds all ${n}.`, fixed: true });
    } else {
      issues.push({ code: 'total-mismatch', severity: 'warn', sheet: sheetName, who, title: `${sheetName} TOTAL ${what} for ${label} doesn't add up`, detail: `Shows ${fmtN(shown)}, the weeks add to ${fmtN(sum)}. The dashboard uses the weekly figures.`, fixed: true });
    }
  }
}

const fmtN = (n) => (Math.round(n * 100) / 100).toLocaleString('en-AU');

function flagRepeatedFigures(rep, oth, issues) {
  const groups = new Map();
  const add = (key, r, label) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ r, label }); };
  for (const r of rep) if (r.revenue > 0) add(`${r.staff}|${r.orders}|${r.revenue}|${r.hours}`, r, r.staff);
  for (const r of oth) if (r.revenue > 0) add(`other|${r.orders}|${r.revenue}`, r, 'other');
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const [{ r: first, label }] = list;
    const who = label === 'other' ? 'Other stores' : label.charAt(0).toUpperCase() + label.slice(1);
    const weeks = list.map((x) => fmtDate(x.r.we)).join(', ');
    for (const { r } of list.slice(1)) {
      r.flags = [...(r.flags || []), 'repeat'];
      issues.push({ code: 'repeated-figures', severity: 'warn', we: r.we, staff: label === 'other' ? undefined : label, title: `${who}: identical figures in ${list.length} different weeks`, detail: `${first.orders} orders · $${first.revenue.toLocaleString('en-AU')}${label !== 'other' ? ` · ${first.hours} h` : ''} appears for weeks ending ${weeks}. Likely copied forward when a new month was started — worth checking against Marissa's photos.` });
    }
  }
  // collapse to one issue per group
  const seen = new Set();
  for (let i = issues.length - 1; i >= 0; i--) {
    if (issues[i].code !== 'repeated-figures') continue;
    const k = issues[i].title + issues[i].detail;
    if (seen.has(k)) issues.splice(i, 1); else seen.add(k);
  }
}

function flagOddOrderValues(rep, oth, issues) {
  const all = [...rep.filter((r) => r.orders >= 5), ...oth.filter((r) => r.orders >= 5)];
  const avgs = all.map((r) => r.revenue / r.orders).sort((a, b) => a - b);
  const median = avgs[Math.floor(avgs.length / 2)] || 30;
  const check = (r, who) => {
    if (r.orders < 5 || r.revenue <= 0) return;
    const per = r.revenue / r.orders;
    if (per < median * 0.4 || per > median * 2.5) {
      r.flags = [...(r.flags || []), 'odd-average'];
      issues.push({ code: 'odd-average', severity: 'warn', we: r.we, staff: who === 'other' ? undefined : who, title: `${who === 'other' ? 'Other stores' : who.charAt(0).toUpperCase() + who.slice(1)}: ${r.orders} orders for $${r.revenue.toLocaleString('en-AU')}`, detail: `That's $${per.toFixed(2)} an order — the usual is about $${median.toFixed(0)}. One of the two numbers is probably mistyped.` });
    }
  };
  rep.forEach((r) => check(r, r.staff));
  oth.forEach((r) => check(r, 'other'));
}

// ---- sales workbook (SEDDON sheet) ---------------------------------------------

/**
 * Reads weekly takings and fortnightly wages for one store.
 * @param opts { store: 'seddon' }
 */
export function parseSalesWorkbook(XLSX, wb, opts = {}) {
  const store = norm(opts.store || 'seddon');
  const sheetName = wb.SheetNames.find((n) => norm(n) === store) || wb.SheetNames.find((n) => norm(n).includes(store));
  if (!sheetName) throw new Error(`Couldn't find a "${opts.store || 'SEDDON'}" sheet in this workbook. Sheets found: ${wb.SheetNames.join(', ')}`);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: true });
  const issues = [];
  let hr = -1, cols = {};
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const row = rows[r] || [];
    const names = row.map(norm);
    const w = names.indexOf('week ending');
    const s = names.findIndex((h) => h === 'sales');
    if (w >= 0 && s >= 0) {
      hr = r;
      cols = {
        week: w, sales: s,
        discounts: names.findIndex((h) => h.startsWith('discount')),
        wages: names.findIndex((h) => h.includes('wages') && h.includes('fortnight')),
        wagesPct: names.findIndex((h) => h.includes('wages') && h.includes('%')),
        turnover: names.findIndex((h) => h.includes('turnover')),
      };
      break;
    }
  }
  if (hr < 0) throw new Error(`The ${sheetName} sheet doesn't have a header row with "week ending" and "Sales".`);

  const takings = [], wages = [];
  let prev = null;
  for (let r = hr + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const raw = row[cols.week];
    if (isBlank(raw)) { if (prev) break; else continue; }
    const res = resolveWeekEnding(raw, prev ? addDays(prev, 7) : null);
    if (!res.iso) { issues.push({ code: 'date-unreadable', severity: 'error', sheet: sheetName, cell: cellRef(sheetName, r, cols.week), title: `Couldn't read the date "${raw}"`, detail: 'Row skipped.' }); continue; }
    if (res.fix === 'year') issues.push({ code: 'date-year', severity: 'warn', sheet: sheetName, cell: cellRef(sheetName, r, cols.week), we: res.iso, title: `Week ending typed as ${raw}`, detail: `Read as ${fmtDate(res.iso)} — the year doesn't follow on from the week before.`, fixed: true });
    if (res.fix === 'assumed') issues.push({ code: 'date-assumed', severity: 'error', sheet: sheetName, cell: cellRef(sheetName, r, cols.week), we: res.iso, title: `Couldn't read the date "${raw}"`, detail: `Treated as ${fmtDate(res.iso)}.`, fixed: true });
    prev = res.iso;
    const sales = parseMoney(row[cols.sales]);
    if (sales == null) continue;
    takings.push({ we: res.iso, sales: round2(sales), discounts: cols.discounts >= 0 ? round2(parseMoney(row[cols.discounts]) ?? 0) : 0, src: cellRef(sheetName, r, cols.sales) });
    if (cols.wages >= 0) {
      const w = parseMoney(row[cols.wages]);
      if (w != null && w > 0) wages.push({ periodEnd: res.iso, days: 14, amount: round2(w), source: 'sheet', src: cellRef(sheetName, r, cols.wages) });
    }
  }
  return { sheet: sheetName, takings, wages, issues };
}

const round2 = (n) => (n == null ? n : Math.round(n * 100) / 100);
