// Seddon Workroom — Admin page.
// Everything happens in this browser: workbooks are read here, photos are shrunk and encrypted here,
// and the result is committed straight to the GitHub repository with your token.
import { GitHub } from './lib/github.js';
import { unlockKey, readVault, writeVault, changePassphrase, encryptBytes } from './lib/vault.js';
import { parseRepairsWorkbook, parseSalesWorkbook } from './lib/parse.js';
import { mergeRepairsImport, mergeSalesImport, addManualWeek, addDaily, addPhotos, removePhoto, keepRemoteEh, newId } from './lib/merge.js';
import { fmtDate, addDays, sundayOnOrAfter } from './lib/dates.js';
import { money, plural } from './lib/format.js';

const VAULT_PATH = 'data/vault.json';
const WORKFLOW = 'eh-sync.yml';

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const $ = (s, r = document) => r.querySelector(s);
const ls = {
  get(k, d) { try { const v = localStorage.getItem(`seddon.admin.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`seddon.admin.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};
function setResult(el, text, kind) { el.textContent = text; el.className = `result${kind ? ` ${kind}` : ''}`; }
const todayMelbourne = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());

const A = { gh: null, vault: null, vaultSha: null, key: null, saved: null, draft: null, pending: [], changes: [], notes: {} };

// Each step's last message survives the re-render that follows a change.
function resultBox(stepKey) {
  const el = h('div', { class: 'result', role: 'status' });
  const n = A.notes[stepKey];
  if (n) { el.className = `result${n.kind ? ` ${n.kind}` : ''}`; el.append(...(typeof n.content === 'string' ? [n.content] : [n.content])); }
  el.dataset.step = stepKey;
  return el;
}
function report(stepKey, el, content, kind) {
  A.notes[stepKey] = { content, kind };
  el.textContent = '';
  el.className = `result${kind ? ` ${kind}` : ''}`;
  el.append(content);
}

// ---------- connect ----------
const conn = ls.get('github', {});
$('#ghOwner').value = conn.owner || '';
$('#ghRepo').value = conn.repo || 'seddon-workroom';
$('#ghBranch').value = conn.branch || 'main';
$('#ghToken').value = conn.token || '';
if (!conn.owner) {
  // On https://<owner>.github.io/<repo>/admin.html we can guess both.
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (m) { $('#ghOwner').value = m[1]; const seg = location.pathname.split('/').filter(Boolean)[0]; if (seg && !seg.endsWith('.html')) $('#ghRepo').value = seg; }
}

$('#connectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = $('#connectResult');
  const cfg = { owner: $('#ghOwner').value.trim(), repo: $('#ghRepo').value.trim(), branch: $('#ghBranch').value.trim() || 'main', token: $('#ghToken').value.trim() };
  setResult(res, 'Checking…');
  try {
    const gh = new GitHub(cfg);
    const info = await gh.check();
    const file = await gh.readFile(VAULT_PATH);
    if (!file) throw new Error(`Connected, but there's no ${VAULT_PATH} in ${cfg.owner}/${cfg.repo}. Upload the site files first.`);
    A.gh = gh; A.vault = JSON.parse(new TextDecoder().decode(file.bytes)); A.vaultSha = file.sha;
    ls.set('github', cfg);
    setResult(res, `Connected to ${cfg.owner}/${cfg.repo}${info.private ? ' (private repository)' : ''}.`, 'ok');
    $('#unlockPanel').hidden = false;
    const saved = sessionStorage.getItem('seddon.admin.key');
    if (saved) { try { await unlockWith(Uint8Array.from(atob(saved), (c) => c.charCodeAt(0))); return; } catch { sessionStorage.removeItem('seddon.admin.key'); } }
    $('#adminPass').focus();
  } catch (ex) { setResult(res, ex.message, 'err'); }
});
if (conn.owner && conn.token) $('#connectForm').requestSubmit();

// ---------- unlock ----------
$('#unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = $('#unlockResult');
  setResult(res, 'Unlocking…');
  try {
    const key = await unlockKey(A.vault, $('#adminPass').value);
    await unlockWith(key);
    setResult(res, 'Unlocked.', 'ok');
  } catch (ex) { setResult(res, ex.message === 'wrong-passphrase' ? "That passphrase didn't work." : ex.message, 'err'); }
});

async function unlockWith(key) {
  const data = await readVault(A.vault, key);
  A.key = key; A.saved = data; A.draft = structuredClone(data); A.pending = []; A.changes = [];
  try { sessionStorage.setItem('seddon.admin.key', btoa(String.fromCharCode(...key))); } catch { /* ignore */ }
  $('#connectPanel').hidden = true; $('#unlockPanel').hidden = true;
  renderWork();
}

function stage(description, nextDraft, files = []) {
  A.draft = nextDraft;
  A.pending.push(...files);
  A.changes.push(description);
  renderWork();
  const bar = $('#publishBar'); if (bar) bar.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- the working area ----------
function renderWork() {
  const work = $('#work');
  work.hidden = false;
  work.textContent = '';
  const d = A.draft;
  const weeks = [...new Set(d.repairs.map((r) => r.we))].sort();
  work.append(
    h('section', { class: 'panel' },
      h('header', null, h('h2', null, 'What’s on the dashboard'), h('p', null, `${A.gh.owner}/${A.gh.repo}`)),
      h('dl', { class: 'kv' },
        h('dt', null, 'Repairs weeks'), h('dd', null, weeks.length ? `${fmtDate(weeks[0])} – ${fmtDate(weeks.at(-1))} (${plural(weeks.length, 'week')})` : 'None'),
        h('dt', null, 'Store takings'), h('dd', null, d.takings?.length ? `to ${fmtDate(d.takings.at(-1).we)}` : 'None'),
        h('dt', null, 'Store wages'), h('dd', null, d.wages?.length ? `to the fortnight ending ${fmtDate(d.wages.at(-1).periodEnd)}` : 'None'),
        h('dt', null, 'Employment Hero'), h('dd', null, d.eh?.syncedAt ? `last synced ${new Date(d.eh.syncedAt).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', dateStyle: 'medium', timeStyle: 'short' })}` : 'not connected yet'),
        h('dt', null, 'Photos'), h('dd', null, plural((d.photos || []).length, 'photo')),
        h('dt', null, 'Data checks'), h('dd', null, `${(d.issues || []).filter((i) => !i.fixed).length} to check, ${(d.issues || []).filter((i) => i.fixed).length} corrected automatically`))),
    workbookStep(), salesStep(), weekStep(), dayStep(), photoStep(), settingsStep(), ehStep(), passStep(),
  );
  if (A.changes.length) work.appendChild(publishBar());
}

function step(n, title, sub, ...body) {
  return h('section', { class: 'panel step' }, h('header', null, h('h2', null, h('span', { class: 'n' }, n), title), sub ? h('p', null, sub) : null), ...body);
}

function publishBar() {
  const btn = h('button', { class: 'btn', type: 'button' }, 'Publish');
  const undo = h('button', { class: 'btn ghost', type: 'button', style: { background: 'transparent', color: 'inherit', borderColor: 'rgba(255,255,255,.35)' } }, 'Discard');
  const msg = h('span', null, `${plural(A.changes.length, 'change')} ready: ${A.changes.join('; ')}`);
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Publishing…';
    try {
      // Take the newest Employment Hero figures from GitHub in case the sync ran since we opened this page.
      const latest = await A.gh.readFile(VAULT_PATH);
      let draft = A.draft;
      if (latest && latest.sha !== A.vaultSha) {
        const remoteVault = JSON.parse(new TextDecoder().decode(latest.bytes));
        if (remoteVault.key.ct !== A.vault.key.ct || remoteVault.kdf.salt !== A.vault.kdf.salt) {
          // Passphrase was changed elsewhere; the data key is the same, so the vault header from GitHub stays.
          A.vault = { ...A.vault, kdf: remoteVault.kdf, key: remoteVault.key };
        }
        draft = keepRemoteEh(draft, await readVault(remoteVault, A.key));
      }
      draft = { ...draft, updatedAt: new Date().toISOString() };
      const vault = await writeVault(A.vault, A.key, draft);
      const files = [{ path: VAULT_PATH, text: JSON.stringify(vault) }, ...A.pending];
      await A.gh.commit(files, `Admin: ${A.changes.join('; ')}`.slice(0, 300));
      const fresh = await A.gh.readFile(VAULT_PATH);
      A.vault = vault; A.vaultSha = fresh?.sha; A.saved = draft; A.draft = structuredClone(draft); A.pending = []; A.changes = []; A.notes = {};
      renderWork();
      flash('Published. The dashboard shows the new figures within a minute or two.');
    } catch (ex) {
      btn.disabled = false; btn.textContent = 'Publish';
      flash(`Couldn't publish: ${ex.message}`, true);
    }
  });
  undo.addEventListener('click', () => { A.draft = structuredClone(A.saved); A.pending = []; A.changes = []; A.notes = {}; renderWork(); });
  return h('div', { class: 'publish', id: 'publishBar', role: 'region', 'aria-label': 'Unpublished changes' }, msg, h('div', { class: 'row' }, undo, btn));
}
function flash(text, err) {
  const t = h('div', { class: 'toast', role: 'status', style: err ? { background: 'var(--bad)' } : null }, text);
  document.body.appendChild(t); setTimeout(() => t.remove(), err ? 7000 : 4000);
}

// ---------- 1. workbook ----------
function workbookStep() {
  const input = h('input', { id: 'wbFile', type: 'file', accept: '.xlsx,.xlsm,.xls' });
  const out = resultBox('A');
  input.addEventListener('change', async () => {
    const f = input.files[0]; if (!f) return;
    report('A', out, `Reading ${f.name}…`);
    try {
      const wb = window.XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
      const parsed = parseRepairsWorkbook(window.XLSX, wb, { staff: A.draft.staff });
      if (!parsed.repairs.length) throw new Error('No weekly figures found. Is this the Seddon Repairs vs Revenue workbook?');
      const r = mergeRepairsImport(A.draft, parsed, f.name);
      const s = r.summary;
      const changed = s.added || s.changed || s.newStaff.length;
      const node = h('div', null,
        h('p', null, h('strong', null, `${f.name}, ${fmtDate(s.from)} – ${fmtDate(s.to)}: `), `${s.added} new, ${s.changed} changed, ${s.unchanged} unchanged.`, s.kept ? ` ${s.kept} rows added by hand are kept.` : '', s.newStaff.length ? ` New name found: ${s.newStaff.join(', ')} (added to Settings).` : ''),
        s.changedRows.length ? h('p', { class: 'small' }, `Changed: ${s.changedRows.slice(0, 6).map((c) => `${c.staff} W/E ${fmtDate(c.we, { short: true })} ${money(c.before.revenue)} → ${money(c.after.revenue)}`).join('; ')}${s.changedRows.length > 6 ? '…' : ''}`) : null,
        h('p', { class: 'small' }, `${parsed.issues.filter((i) => !i.fixed).length} figures to check, ${parsed.issues.filter((i) => i.fixed).length} corrected automatically (see Data checks on the dashboard).`),
        changed ? null : h('p', { class: 'small' }, 'Nothing new — the dashboard already has these figures.'));
      report('A', out, node, changed ? 'ok' : '');
      if (changed) stage(`workbook to ${fmtDate(s.to, { short: true })}`, r.data);
    } catch (ex) { report('A', out, ex.message, 'err'); }
    input.value = '';
  });
  return step('A', 'Update from the repairs workbook', 'Upload "Seddon Repairs vs Revenue.xlsx" after you’ve added the week',
    h('div', { class: 'form' }, h('label', { class: 'field', for: 'wbFile' }, 'Workbook', input), out));
}

// ---------- 2. sales sheet ----------
function salesStep() {
  const input = h('input', { id: 'salesFile', type: 'file', accept: '.xlsx,.xlsm,.xls' });
  const out = resultBox('B');
  input.addEventListener('change', async () => {
    const f = input.files[0]; if (!f) return;
    report('B', out, `Reading ${f.name}…`);
    try {
      const wb = window.XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
      const parsed = parseSalesWorkbook(window.XLSX, wb, { store: 'SEDDON' });
      const r = mergeSalesImport(A.draft, parsed, f.name.replace(/\.[^.]+$/, '') + '.xlsx');
      const s = r.summary;
      const changed = s.added || s.changed || s.wagesAdded || s.wagesChanged;
      report('B', out, `${parsed.sheet} sheet, ${fmtDate(s.from)} – ${fmtDate(s.to)}: ${s.added} new weeks, ${s.changed} changed; wages ${s.wagesAdded} new, ${s.wagesChanged} changed fortnights.${changed ? '' : ' Nothing new.'}`, changed ? 'ok' : '');
      if (changed) stage(`takings to ${fmtDate(s.to, { short: true })}`, r.data);
    } catch (ex) { report('B', out, ex.message, 'err'); }
    input.value = '';
  });
  return step('B', 'Update store takings and wages', 'Upload "Average Weekly Sales - All Stores.xlsx" — only the SEDDON sheet is read',
    h('div', { class: 'form' }, h('label', { class: 'field', for: 'salesFile' }, 'Workbook', input), out));
}

// ---------- 3. a week by hand ----------
function weekStep() {
  const d = A.draft;
  const lastWe = [...new Set(d.repairs.map((r) => r.we))].sort().at(-1);
  const we = h('input', { id: 'wkWe', type: 'date', value: lastWe ? addDays(lastWe, 7) : sundayOnOrAfter(todayMelbourne()), required: true });
  const staffRows = d.staff.map((s) => h('div', { class: 'row' },
    h('strong', { style: { flex: '0 0 70px', alignSelf: 'center' } }, s.name),
    ...['orders', 'revenue', 'hours', 'days'].map((k) => h('label', { class: 'field narrow', for: `wk-${s.id}-${k}` }, { orders: 'Orders', revenue: 'Revenue $', hours: 'Hours', days: 'Days' }[k], h('input', { id: `wk-${s.id}-${k}`, type: 'number', step: k === 'revenue' ? '0.01' : k === 'hours' ? '0.5' : '1', min: '0', inputmode: 'decimal' })))));
  const out = resultBox('C');
  const form = h('form', { class: 'form' },
    h('div', { class: 'row' }, h('label', { class: 'field narrow', for: 'wkWe' }, 'Week ending (Sunday)', we)),
    ...staffRows,
    h('div', { class: 'row' }, h('strong', { style: { flex: '0 0 70px', alignSelf: 'center' } }, 'Other stores'),
      h('label', { class: 'field narrow', for: 'wk-o-orders' }, 'Orders', h('input', { id: 'wk-o-orders', type: 'number', min: '0', step: '1' })),
      h('label', { class: 'field narrow', for: 'wk-o-revenue' }, 'Repairs $', h('input', { id: 'wk-o-revenue', type: 'number', min: '0', step: '0.01' }))),
    h('div', { class: 'row' }, h('strong', { style: { flex: '0 0 70px', alignSelf: 'center' } }, 'Store'),
      h('label', { class: 'field narrow', for: 'wk-t-sales' }, 'Takings $', h('input', { id: 'wk-t-sales', type: 'number', min: '0', step: '0.01' })),
      h('label', { class: 'field narrow', for: 'wk-t-disc' }, 'Discounts $', h('input', { id: 'wk-t-disc', type: 'number', min: '0', step: '0.01' }))),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Add this week'), out));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      const v = (id) => $(`#${id}`).value;
      const next = addManualWeek(A.draft, {
        we: we.value,
        staff: Object.fromEntries(A.draft.staff.map((s) => [s.id, { orders: v(`wk-${s.id}-orders`), revenue: v(`wk-${s.id}-revenue`), hours: v(`wk-${s.id}-hours`), days: v(`wk-${s.id}-days`) }])),
        other: { orders: v('wk-o-orders'), revenue: v('wk-o-revenue') },
        takings: { sales: v('wk-t-sales'), discounts: v('wk-t-disc') },
      });
      A.notes.C = { content: `Week ending ${fmtDate(we.value)} added — publish to save it.`, kind: 'ok' };
      stage(`week ending ${fmtDate(we.value, { short: true })}`, next);
    } catch (ex) { report('C', out, ex.message, 'err'); }
  });
  return step('C', 'Add a week by hand', 'For a week that isn’t in the workbook yet. Leave a person blank if she didn’t work.', form);
}

// ---------- 4. a day ----------
function dayStep() {
  const date = h('input', { id: 'dayDate', type: 'date', value: todayMelbourne(), required: true });
  const kind = h('select', { id: 'dayKind' }, h('option', { value: 'takings' }, 'Store takings for the day'), ...A.draft.staff.map((s) => h('option', { value: `repairs:${s.id}` }, `${s.name}’s repairs for the day`)), h('option', { value: 'repairs:other' }, 'Repairs in from other stores'));
  const amount = h('input', { id: 'dayAmount', type: 'number', min: '0', step: '0.01', required: true });
  const orders = h('input', { id: 'dayOrders', type: 'number', min: '0', step: '1' });
  const note = h('input', { id: 'dayNote', placeholder: 'Optional' });
  const files = h('input', { id: 'dayPhotos', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true });
  const out = resultBox('D');
  const form = h('form', { class: 'form' },
    h('div', { class: 'row' }, h('label', { class: 'field narrow', for: 'dayDate' }, 'Date', date), h('label', { class: 'field', for: 'dayKind' }, 'What it is', kind)),
    h('div', { class: 'row' }, h('label', { class: 'field narrow', for: 'dayAmount' }, 'Amount $', amount), h('label', { class: 'field narrow', for: 'dayOrders' }, 'Orders', orders), h('label', { class: 'field', for: 'dayNote' }, 'Note', note)),
    h('label', { class: 'field', for: 'dayPhotos' }, 'Marissa’s photo (optional)', files),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Add this day'), out));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      report('D', out, 'Working…');
      const [k, staff] = kind.value.split(':');
      const { photos, pending } = await preparePhotos([...files.files], date.value, note.value);
      let next = addDaily(A.draft, { date: date.value, kind: k, staff: staff || null, amount: amount.value, orders: orders.value, note: note.value, photoIds: photos.map((p) => p.id) });
      if (photos.length) next = addPhotos(next, photos);
      A.notes.D = { content: `${fmtDate(date.value)} added${photos.length ? ` with ${plural(photos.length, 'photo')}` : ''} — publish to save it.`, kind: 'ok' };
      stage(`${fmtDate(date.value, { short: true })} ${k === 'takings' ? 'takings' : 'repairs'}${photos.length ? ` + ${plural(photos.length, 'photo')}` : ''}`, next, pending);
    } catch (ex) { report('D', out, ex.message, 'err'); }
  });
  return step('D', 'Add a day', 'A day’s figure from Marissa’s photo. Weekly totals still come from the workbook.', form);
}

// ---------- 5. photos ----------
function photoStep() {
  const files = h('input', { id: 'phFiles', type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true });
  const date = h('input', { id: 'phDate', type: 'date', value: todayMelbourne() });
  const cap = h('input', { id: 'phCap', placeholder: 'e.g. Repair book, Tuesday' });
  const out = resultBox('E');
  const add = h('button', { class: 'btn', type: 'button' }, 'Add photos');
  add.addEventListener('click', async () => {
    if (!files.files.length) { report('E', out, 'Choose one or more photos first.', 'err'); return; }
    try {
      report('E', out, `Shrinking and encrypting ${plural(files.files.length, 'photo')}…`);
      const { photos, pending } = await preparePhotos([...files.files], date.value, cap.value);
      A.notes.E = { content: `${plural(photos.length, 'photo')} ready — publish to put them on the dashboard.`, kind: 'ok' };
      stage(`${plural(photos.length, 'photo')} for ${fmtDate(date.value, { short: true })}`, addPhotos(A.draft, photos), pending);
    } catch (ex) { report('E', out, ex.message, 'err'); }
  });
  const list = h('div', { class: 'thumbs' });
  const existing = [...(A.draft.photos || [])].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 40);
  for (const p of existing) {
    const img = h('img', { alt: p.caption || fmtDate(p.date) });
    const del = h('button', { class: 'linkbtn', type: 'button' }, 'Remove');
    del.addEventListener('click', () => {
      const r = removePhoto(A.draft, p.id);
      stage(`remove photo ${fmtDate(p.date, { short: true })}`, r.data, r.files.map((path) => ({ path, delete: true })));
    });
    list.appendChild(h('figure', null, img, h('span', null, `${fmtDate(p.date, { short: true })}${p.caption ? ` · ${p.caption}` : ''}`), del));
    const local = A.pending.find((f) => f.path === (p.thumb || p.file) && f.preview);
    if (local) img.src = local.preview;
  }
  return step('E', 'Photos', 'Marissa’s photos are shrunk to a sensible size and encrypted before they leave this computer',
    h('div', { class: 'form' },
      h('div', { class: 'row' }, h('label', { class: 'field', for: 'phFiles' }, 'Photos (JPG or PNG)', files), h('label', { class: 'field narrow', for: 'phDate' }, 'Date they’re from', date), h('label', { class: 'field', for: 'phCap' }, 'Caption', cap)),
      h('div', { class: 'row' }, add, out),
      existing.length ? h('div', null, h('p', { class: 'small muted', style: { margin: '6px 0' } }, `${plural((A.draft.photos || []).length, 'photo')} on the dashboard${existing.length < (A.draft.photos || []).length ? ' (newest 40 shown)' : ''}`), list) : null));
}

async function preparePhotos(fileList, date, caption) {
  const photos = [], pending = [];
  for (const f of fileList) {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) throw new Error(`${f.name} isn't a JPG or PNG. iPhone HEIC photos need saving as JPG first (WhatsApp sends JPGs).`);
    const bmp = await createImageBitmap(f);
    const full = await shrink(bmp, 2000, 0.85);
    const thumb = await shrink(bmp, 480, 0.75);
    bmp.close?.();
    const id = newId('ph');
    const file = `photos/${id}.bin`, thumbPath = `photos/${id}-t.bin`;
    pending.push({ path: file, bytes: await encryptBytes(full.bytes, A.key) });
    pending.push({ path: thumbPath, bytes: await encryptBytes(thumb.bytes, A.key), preview: URL.createObjectURL(new Blob([thumb.bytes], { type: 'image/jpeg' })) });
    photos.push({ id, date, caption: caption || '', file, thumb: thumbPath, mime: 'image/jpeg', w: full.w, h: full.h, encrypted: true, original: f.name, addedAt: new Date().toISOString() });
  }
  return { photos, pending };
}
async function shrink(bmp, max, quality) {
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), hgt = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt);
  ctx.drawImage(bmp, 0, 0, w, hgt);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h: hgt };
}

// ---------- 6. settings ----------
function settingsStep() {
  const d = A.draft;
  const st = d.settings || {};
  const tbody = h('tbody');
  const rows = d.staff.map((s) => ({ ...s }));
  const cell = (s, k, type = 'text', step) => {
    const i = h('input', { id: `st-${s.id}-${k}`, type, step, value: k === 'aliases' ? (s.aliases || []).join(', ') : (s[k] ?? ''), 'aria-label': `${s.name} ${k}` });
    return h('td', null, i);
  };
  for (const s of rows) tbody.appendChild(h('tr', null, h('td', null, h('strong', null, s.name)), cell(s, 'payRate', 'number', '0.01'), cell(s, 'hoursPerDay', 'number', '0.5'), cell(s, 'maxDays', 'number', '1'), cell(s, 'ehName'), cell(s, 'aliases')));
  const table = h('table', { class: 'stafftable' }, h('thead', null, h('tr', null, ['Seamstress', 'Pay rate $/h', 'Repair hours / day', 'Most days / week', 'Name in Employment Hero', 'Other spellings'].map((x) => h('th', null, x)))), tbody);
  const newName = h('input', { id: 'stNew', placeholder: 'Name' });
  const addBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Add a seamstress');
  addBtn.addEventListener('click', () => {
    const name = newName.value.trim(); if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (d.staff.some((s) => s.id === id)) return flash(`${name} is already listed.`, true);
    stage(`add ${name}`, { ...A.draft, staff: [...A.draft.staff, { id, name, aliases: [], hoursPerDay: 5, maxDays: 5, payRate: null, ehName: '' }] });
  });
  const num = (id, label, value, stepv = '1') => h('label', { class: 'field narrow', for: id }, label, h('input', { id, type: 'number', step: stepv, min: '0', value }));
  const save = h('button', { class: 'btn', type: 'button' }, 'Save settings');
  save.addEventListener('click', () => {
    const staff = A.draft.staff.map((s) => {
      const g = (k) => $(`#st-${s.id}-${k}`)?.value ?? '';
      const n = (k) => { const v = parseFloat(g(k)); return Number.isFinite(v) && v > 0 ? v : null; };
      return { ...s, payRate: n('payRate'), hoursPerDay: n('hoursPerDay') || s.hoursPerDay, maxDays: n('maxDays') || s.maxDays, ehName: g('ehName').trim(), aliases: g('aliases').split(',').map((x) => x.trim()).filter(Boolean) };
    });
    const g = (id) => parseFloat($(`#${id}`).value);
    const settings = { ...st, onCostPct: g('setOnCost'), catchUpWeeks: g('setCatch') || 4, backlogWeeks: g('setBacklog') || 8, productivityWeeks: g('setProd') || 8, coverHoursPerDay: g('setCover') || 5 };
    stage('settings', { ...A.draft, staff, settings });
  });
  return step('F', 'Settings', 'Pay rates turn hours into wage cost until Employment Hero is connected',
    h('div', { class: 'scroll' }, table),
    h('div', { class: 'row', style: { marginTop: '10px' } }, h('label', { class: 'field', for: 'stNew' }, 'New seamstress', newName), addBtn),
    h('div', { class: 'row', style: { marginTop: '14px' } },
      num('setOnCost', 'On-costs % (super etc.)', st.onCostPct ?? 12, '0.5'), num('setCatch', 'Clear backlog over (weeks)', st.catchUpWeeks ?? 4),
      num('setBacklog', 'Backlog look-back (weeks)', st.backlogWeeks ?? 8), num('setProd', '$/hour from last (weeks)', st.productivityWeeks ?? 8),
      num('setCover', 'Hours in a cover day', st.coverHoursPerDay ?? 5, '0.5')),
    h('div', { class: 'row', style: { marginTop: '12px' } }, save));
}

// ---------- 7. Employment Hero ----------
function ehStep() {
  const d = A.draft;
  const out = h('div', { class: 'result', role: 'status' });
  const run = (mode) => async () => {
    setResult(out, mode === 'check' ? 'Starting a connection test…' : 'Starting a sync…');
    try {
      await A.gh.runWorkflow(WORKFLOW, { mode });
      setResult(out, `Started. It takes about a minute — see the Actions tab on GitHub. ${mode === 'sync' ? 'Reload this page afterwards to pick up the new figures.' : ''}`, 'ok');
    } catch (ex) { setResult(out, `${ex.message} The token also needs "Actions: Read and write" to start this from here — or use Actions → Employment Hero sync → Run workflow on GitHub.`, 'err'); }
  };
  const status = d.eh?.syncedAt
    ? `Last synced ${new Date(d.eh.syncedAt).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', dateStyle: 'medium', timeStyle: 'short' })}: ${plural(d.eh.daily?.length || 0, 'day')} of hours and wage cost for ${(d.eh.locations || []).join(', ') || 'Seddon'}.`
    : 'Not connected yet. Once set up, it runs every morning at about 6:30 and fills in wage cost and hours automatically.';
  return step('G', 'Employment Hero (live wages)', null,
    h('p', null, status),
    h('ol', { class: 'steps', style: { margin: '12px 0' } },
      h('li', null, 'In Employment Hero Payroll, open your profile (top right) → My Account, and copy the API key at the bottom of the page.'),
      h('li', null, 'Note the business ID: the number in the web address when the business is open, e.g. …/Business/', h('code', null, '123456'), '/….'),
      h('li', null, 'On GitHub open the repository → Settings → Secrets and variables → Actions → New repository secret. Add ', h('code', null, 'EH_API_KEY'), ', ', h('code', null, 'EH_BUSINESS_ID'), ' and ', h('code', null, 'DASHBOARD_PASSPHRASE'), ' (the dashboard passphrase).'),
      h('li', null, 'Optional: under Variables add ', h('code', null, 'EH_LOCATION'), ' if the location isn’t called "Seddon" in Employment Hero.'),
      h('li', null, 'Press “Test the connection” below. When it passes, press “Sync now”.')),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: run('check') }, 'Test the connection'), h('button', { class: 'btn', type: 'button', onclick: run('sync') }, 'Sync now'), out));
}

// ---------- 8. passphrase ----------
function passStep() {
  const p1 = h('input', { id: 'np1', type: 'password', autocomplete: 'new-password', minlength: '12' });
  const p2 = h('input', { id: 'np2', type: 'password', autocomplete: 'new-password', minlength: '12' });
  const out = h('div', { class: 'result', role: 'status' });
  const btn = h('button', { class: 'btn', type: 'button' }, 'Change passphrase');
  btn.addEventListener('click', async () => {
    if (p1.value !== p2.value) return setResult(out, 'The two passphrases don’t match.', 'err');
    if (A.changes.length) return setResult(out, 'Publish or discard your other changes first.', 'err');
    try {
      btn.disabled = true; setResult(out, 'Changing…');
      const latest = await A.gh.readFile(VAULT_PATH);
      const base = latest ? JSON.parse(new TextDecoder().decode(latest.bytes)) : A.vault;
      const v = await changePassphrase(base, A.key, p1.value);
      await A.gh.commit([{ path: VAULT_PATH, text: JSON.stringify(v) }], 'Admin: change passphrase');
      A.vault = v; A.vaultSha = (await A.gh.readFile(VAULT_PATH))?.sha;
      p1.value = ''; p2.value = '';
      setResult(out, 'Changed. Update the DASHBOARD_PASSPHRASE secret on GitHub to the new one, or the Employment Hero sync will stop.', 'ok');
      try { localStorage.removeItem('seddon.key'); sessionStorage.removeItem('seddon.key'); } catch { /* ignore */ }
    } catch (ex) { setResult(out, ex.message, 'err'); } finally { btn.disabled = false; }
  });
  return step('H', 'Change the passphrase', 'Photos don’t need re-uploading — only the lock changes',
    h('div', { class: 'row' }, h('label', { class: 'field', for: 'np1' }, 'New passphrase (12+ characters)', p1), h('label', { class: 'field', for: 'np2' }, 'Type it again', p2)),
    h('div', { class: 'row', style: { marginTop: '10px' } }, btn, out));
}

