// Passphrase lock for the dashboard data and photos.
//
// GitHub Pages sites are public, so the data file is stored encrypted (AES-256-GCM).
// A random data key encrypts the data and every photo; the passphrase only unlocks
// that key, so changing the passphrase never means re-uploading the photos.
// Works in the browser and in Node 20+ (both have crypto.subtle).

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const KDF_ITERATIONS = 310000;

export function toB64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function kekFrom(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const dekKey = (raw) => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

async function seal(key, bytes) {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { iv: toB64(iv), ct: toB64(ct) };
}
async function unseal(key, box) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct)));
}

/** Make a new vault. Returns { vault, key } where key is the raw data key (Uint8Array). */
export async function createVault(data, passphrase, { iterations = KDF_ITERATIONS } = {}) {
  if (!passphrase || passphrase.length < 12) throw new Error('Use a passphrase of at least 12 characters.');
  const key = rand(32);
  const salt = rand(16);
  const kek = await kekFrom(passphrase, salt, iterations);
  const vault = {
    format: 'seddon-vault', v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(salt) },
    key: await seal(kek, key),
    data: await seal(await dekKey(key), enc.encode(JSON.stringify(data))),
    updatedAt: new Date().toISOString(),
  };
  return { vault, key };
}

/** Unlock with the passphrase. Throws Error('wrong-passphrase') if it doesn't match. */
export async function unlockKey(vault, passphrase) {
  const kek = await kekFrom(passphrase, fromB64(vault.kdf.salt), vault.kdf.iterations);
  try { return await unseal(kek, vault.key); } catch { throw new Error('wrong-passphrase'); }
}

export async function readVault(vault, key) {
  const bytes = await unseal(await dekKey(key), vault.data);
  return JSON.parse(dec.decode(bytes));
}

/** Same lock, new contents. */
export async function writeVault(vault, key, data) {
  return { ...vault, data: await seal(await dekKey(key), enc.encode(JSON.stringify(data))), updatedAt: new Date().toISOString() };
}

/** New passphrase, same data key (photos stay as they are). */
export async function changePassphrase(vault, key, newPassphrase) {
  if (!newPassphrase || newPassphrase.length < 12) throw new Error('Use a passphrase of at least 12 characters.');
  const salt = rand(16);
  const kek = await kekFrom(newPassphrase, salt, vault.kdf.iterations || KDF_ITERATIONS);
  return { ...vault, kdf: { ...vault.kdf, salt: toB64(salt) }, key: await seal(kek, key), updatedAt: new Date().toISOString() };
}

/** Photos and other files: 12-byte IV followed by the ciphertext. */
export async function encryptBytes(bytes, key) {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await dekKey(key), bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0); out.set(ct, 12);
  return out;
}
export async function decryptBytes(bytes, key) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, await dekKey(key), u.subarray(12)));
}
