// Australian number formatting helpers.

const aud0 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0, minimumFractionDigits: 0 });
const aud2 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 2, minimumFractionDigits: 2 });
const num0 = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });

export const money = (n, dp = 0) => (n == null || !Number.isFinite(n) ? '—' : (dp ? aud2 : aud0).format(n));
export const moneyK = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1000) return `${n < 0 ? '−' : ''}$${num1.format(a / 1000)}k`;
  return money(n);
};
export const int = (n) => (n == null || !Number.isFinite(n) ? '—' : num0.format(n));
export const hrs = (n) => (n == null || !Number.isFinite(n) ? '—' : `${num1.format(n)} h`);
export const pct = (n, dp = 0) => (n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(dp)}%`);
export const signedPct = (n, dp = 0) => (n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n * 100).toFixed(dp)}%`);
export const signedMoney = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${aud0.format(Math.abs(n))}`);
export const plural = (n, one, many = `${one}s`) => `${num1.format(n)} ${Math.abs(n) === 1 ? one : many}`;
