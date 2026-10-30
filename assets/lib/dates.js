// Date helpers. All dates are handled as plain calendar days (UTC midnight)
// so a Melbourne week never shifts by a day in another timezone.

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ymd(y, m, d) {
  // m is 1-12. Returns a Date at UTC midnight, or null if the day doesn't exist.
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function toISO(dt) {
  if (!dt) return null;
  return dt.toISOString().slice(0, 10);
}

export function fromISO(s) {
  if (!s) return null;
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return ymd(y, m, d);
}

export function addDays(iso, n) {
  const dt = typeof iso === 'string' ? fromISO(iso) : iso;
  return toISO(new Date(dt.getTime() + n * DAY));
}

export function diffDays(a, b) {
  // a - b in days
  const da = typeof a === 'string' ? fromISO(a) : a;
  const db = typeof b === 'string' ? fromISO(b) : b;
  return Math.round((da.getTime() - db.getTime()) / DAY);
}

export function isSunday(dt) {
  const d = typeof dt === 'string' ? fromISO(dt) : dt;
  return d.getUTCDay() === 0;
}

export function sundayOnOrAfter(iso) {
  const d = fromISO(iso);
  const add = (7 - d.getUTCDay()) % 7;
  return addDays(iso, add);
}

export function weekStart(weISO) {
  return addDays(weISO, -6); // Monday
}

export function fmtDate(iso, opts = {}) {
  const d = fromISO(iso);
  if (!d) return '';
  const day = d.getUTCDate();
  const mon = MONTHS[d.getUTCMonth()];
  const yr = d.getUTCFullYear();
  if (opts.short) return `${day} ${mon}`;
  if (opts.weekday) return `${DAYS[d.getUTCDay()]} ${day} ${mon} ${yr}`;
  return `${day} ${mon} ${yr}`;
}

export function fmtRange(fromISO_, toISO_) {
  const a = fromISO(fromISO_), b = fromISO(toISO_);
  if (a.getUTCFullYear() === b.getUTCFullYear()) {
    if (a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
    return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  }
  return `${fmtDate(fromISO_)} – ${fmtDate(toISO_)}`;
}

export function monthKey(iso) { return String(iso).slice(0, 7); }

export function fmtMonth(key, long = true) {
  const [y, m] = key.split('-').map(Number);
  return `${(long ? MONTHS_LONG : MONTHS)[m - 1]} ${y}`;
}

export function monthIndexFromName(name) {
  const n = String(name || '').trim().toLowerCase();
  for (let i = 0; i < 12; i++) {
    if (n.startsWith(MONTHS_LONG[i].toLowerCase()) || n.startsWith(MONTHS[i].toLowerCase())) return i + 1;
  }
  return null;
}

export function excelSerialToISO(serial) {
  // Excel 1900 date system (with the 1900 leap-year bug offset)
  const ms = Math.round((serial - 25569) * DAY);
  const dt = new Date(ms);
  return toISO(ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()));
}

export { MONTHS, MONTHS_LONG, DAYS };
