#!/usr/bin/env node
// Employment Hero Payroll -> Seddon Workroom.
// Runs in GitHub Actions (see .github/workflows/eh-sync.yml). Pulls timesheet hours and their cost for the
// Seddon location, adds them to the encrypted data file, and saves it. Nothing readable leaves the repo:
// the log only shows counts and location names, because Actions logs on a public repository are public.
//
// Settings (GitHub → Settings → Secrets and variables → Actions):
//   secrets:   EH_API_KEY, EH_BUSINESS_ID, DASHBOARD_PASSPHRASE
//   variables: EH_LOCATION (default "Seddon"), EH_BASE_URL (default https://api.yourpayroll.com.au), EH_WEEKS (default 26)
// MODE=check tests the connection and prints what it can see; MODE=sync (default) updates data/vault.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlockKey, readVault, writeVault } from '../assets/lib/vault.js';
import { addDays, toISO, sundayOnOrAfter } from '../assets/lib/dates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.join(here, '..', 'data', 'vault.json');
const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const MODE = env('MODE', 'sync');
const BASE = env('EH_BASE_URL', 'https://api.yourpayroll.com.au').replace(/\/+$/, '');
const KEY = env('EH_API_KEY');
const BIZ = env('EH_BUSINESS_ID');
const PASS = env('DASHBOARD_PASSPHRASE');
const LOCATION = env('EH_LOCATION', 'Seddon');
const WEEKS = Math.max(2, Math.min(104, parseInt(env('EH_WEEKS', '26'), 10) || 26));

const log = (...a) => console.log(...a);
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

async function api(p, params = {}) {
  const url = new URL(`${BASE}/api/v2${p}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`, Accept: 'application/json' } });
  if (r.status === 401) fail('Employment Hero rejected the API key (401). Copy it again from Payroll → My Account and update the EH_API_KEY secret.');
  if (r.status === 403) fail(`Employment Hero refused access (403) to ${p.replace(/\d+/g, '…')}. The API key's user needs access to this business.`);
  if (r.status === 404) fail(`Not found (404): ${p.replace(/\d{3,}/g, '…')}. Check EH_BUSINESS_ID and EH_BASE_URL.`);
  if (!r.ok) fail(`Employment Hero returned ${r.status} for ${p.replace(/\d{3,}/g, '…')}.`);
  return r.json();
}

// Some list endpoints page with $top/$skip; stop when a page is short or repeats.
async function all(p, params = {}) {
  const out = []; const seen = new Set();
  for (let skip = 0; skip < 20000; skip += 100) {
    const page = await api(p, { ...params, $top: 100, $skip: skip });
    const rows = Array.isArray(page) ? page : page?.items || page?.data || [];
    let fresh = 0;
    for (const row of rows) { const id = row.id ?? JSON.stringify(row); if (!seen.has(id)) { seen.add(id); out.push(row); fresh++; } }
    if (rows.length < 100 || fresh === 0) break;
  }
  return out;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null);
const day = (iso) => String(iso).slice(0, 10);

function lineHours(t) {
  const u = num(t.units) ?? num(t.totalHours) ?? num(t.hours);
  if (u != null && u > 0) return u;
  if (!t.startTime || !t.endTime) return 0;
  let ms = new Date(t.endTime) - new Date(t.startTime);
  for (const b of t.breaks || []) if (b.startTime && b.endTime) ms -= new Date(b.endTime) - new Date(b.startTime);
  return Math.max(0, ms / 3.6e6);
}
function lineCost(t, hours) {
  const c = num(t.cost) ?? num(t.costCalculated) ?? num(t.totalCost) ?? num(t.costs?.total);
  if (c != null) return c;
  const rate = num(t.rate) ?? num(t.payRate);
  return rate != null ? rate * hours : null;
}

async function main() {
  if (!KEY) fail('EH_API_KEY secret is missing.');
  log(`Mode: ${MODE}. API: ${BASE}`);

  if (!BIZ) {
    const biz = await api('/business');
    log(`EH_BUSINESS_ID is not set. Businesses this key can see: ${(biz || []).map((b) => `${b.id} (${b.name})`).join(', ') || 'none'}`);
    fail('Add the right number as the EH_BUSINESS_ID secret.');
  }

  const locations = await api(`/business/${BIZ}/location`);
  const want = LOCATION.toLowerCase();
  const matched = (locations || []).filter((l) => String(l.name || '').toLowerCase().includes(want) || String(l.fullyQualifiedName || '').toLowerCase().includes(want));
  log(`Locations in Employment Hero: ${(locations || []).length}. Matching "${LOCATION}": ${matched.map((l) => l.name).join(', ') || 'none'}`);
  if (!matched.length) {
    log(`Location names available: ${(locations || []).map((l) => l.name).join(', ')}`);
    fail(`No location called "${LOCATION}". Set the EH_LOCATION variable to one of the names above.`);
  }

  // In sync mode open the data first, so a wrong passphrase stops the run before any downloading.
  let vault = null, key = null, data = null;
  if (MODE !== 'check') {
    if (!PASS) fail('DASHBOARD_PASSPHRASE secret is missing.');
    vault = JSON.parse(fs.readFileSync(VAULT, 'utf8'));
    try { key = await unlockKey(vault, PASS); } catch { fail('DASHBOARD_PASSPHRASE does not open data/vault.json. Update the secret to the current dashboard passphrase.'); }
    data = await readVault(vault, key);
  }

  // Fortnights line up with the ones in the weekly sales sheet (David's pay fortnights).
  const today = toISO(new Date(Date.now() + 10 * 3600e3)); // Melbourne-ish date; only used to cap the range
  const to = addDays(today, -1);
  const anchor = (data?.wages || []).map((w) => w.periodEnd).sort().at(-1) || sundayOnOrAfter(to);
  const fortnightEnd = (d) => { const we = sundayOnOrAfter(d); const diff = Math.round((new Date(we) - new Date(anchor)) / 864e5); return addDays(anchor, Math.ceil(diff / 14) * 14); };
  const from = addDays(fortnightEnd(addDays(to, -7 * WEEKS)), -13); // first day of a whole fortnight

  const employees = await all(`/business/${BIZ}/employee/unstructured`);
  const nameOf = new Map(employees.map((e) => [e.id, [e.preferredName || e.firstName, e.surname].filter(Boolean).join(' ').trim() || `Employee ${e.id}`]));

  // Timesheets in 4-week chunks, per matched location.
  const lines = [];
  for (const loc of matched) {
    for (let a = from; a <= to; a = addDays(a, 28)) {
      const b = addDays(a, 27) < to ? addDays(a, 27) : to;
      const rows = await all(`/business/${BIZ}/timesheet`, { 'filter.fromDate': a, 'filter.toDate': b, 'filter.locationId': loc.id, 'filter.includeCosts': 'true' });
      for (const t of rows) if (t.locationId == null || t.locationId === loc.id) lines.push(t);
    }
  }
  const withCost = lines.filter((t) => lineCost(t, lineHours(t)) != null).length;
  log(`Employees: ${employees.length}. Timesheet lines at ${matched.map((l) => l.name).join(' / ')} from ${from} to ${to}: ${lines.length} (${withCost} with a cost).`);

  if (MODE === 'check') {
    if (!lines.length) log('No timesheets found in that period — check the location and that timesheets are being submitted.');
    else if (!withCost) log('Timesheets were found but without costs. Make sure the API user can see pay rates.');
    log('\n✓ Connection works. Run the workflow again with mode "sync" to update the dashboard.');
    if (PASS && fs.existsSync(VAULT)) {
      try { await unlockKey(JSON.parse(fs.readFileSync(VAULT, 'utf8')), PASS); log('✓ DASHBOARD_PASSPHRASE opens the data file.'); }
      catch { fail('DASHBOARD_PASSPHRASE does not open data/vault.json. Update the secret to the current dashboard passphrase.'); }
    }
    return;
  }

  // Aggregate
  const weekly = new Map(); const daily = new Map(); const fort = new Map();
  for (const t of lines) {
    const d = day(t.startTime || t.date || t.endTime);
    if (!d || d < from || d > to) continue;
    const hours = lineHours(t);
    const cost = lineCost(t, hours) ?? 0;
    const emp = nameOf.get(t.employeeId) || `Employee ${t.employeeId}`;
    const we = sundayOnOrAfter(d);
    const wk = `${we}|${emp}`;
    const w = weekly.get(wk) || { we, employee: emp, hours: 0, cost: 0 }; w.hours += hours; w.cost += cost; weekly.set(wk, w);
    const dd = daily.get(d) || { date: d, hours: 0, cost: 0, people: new Set() }; dd.hours += hours; dd.cost += cost; dd.people.add(emp); daily.set(d, dd);
    const fe = fortnightEnd(d);
    const f = fort.get(fe) || { periodEnd: fe, amount: 0, hours: 0 }; f.amount += cost; f.hours += hours; fort.set(fe, f);
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  data.eh = {
    syncedAt: new Date().toISOString(),
    source: 'Employment Hero Payroll — timesheets with costs',
    locations: matched.map((l) => l.name),
    from, to,
    weekly: [...weekly.values()].map((w) => ({ ...w, hours: r2(w.hours), cost: r2(w.cost) })).sort((a, b) => a.we.localeCompare(b.we) || a.employee.localeCompare(b.employee)),
    daily: [...daily.values()].map((x) => ({ date: x.date, hours: r2(x.hours), cost: r2(x.cost), people: x.people.size })).sort((a, b) => a.date.localeCompare(b.date)),
    fortnights: [...fort.values()].filter((f) => f.periodEnd <= to).map((f) => ({ ...f, amount: r2(f.amount), hours: r2(f.hours) })).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)),
    note: 'Cost of timesheet hours at this location as Employment Hero calculates it (before super unless pay rates include it).',
  };
  data.updatedAt = data.eh.syncedAt;
  fs.writeFileSync(VAULT, JSON.stringify(await writeVault(vault, key, data)));
  log(`✓ Saved ${data.eh.weekly.length} person-weeks, ${data.eh.daily.length} days and ${data.eh.fortnights.length} fortnights (figures stay encrypted).`);
}

main().catch((e) => fail(e.message));
