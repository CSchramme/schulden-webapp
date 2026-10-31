'use strict';

const CACHE_KEY = 'schulden.cache.v2'; // letzter Stand vom Server, für den Offline-Fall
const LEGACY_KEY = 'schulden.entries.v1'; // Einträge aus der ersten Version ohne Server
const LEGACY_DECLINED_KEY = 'schulden.legacyDeclined';
const HINT_KEY = 'schulden.installHintDismissed';
const MAX_CENTS = 100_000_000_00; // 100 Mio. €
const MAX_PHOTOS = 6; // pro Eintrag, wie auf dem Server
const MAX_PHOTO_SIDE = 2000; // Pixel – reicht, um Kassenbons gut zu lesen

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const dayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
const dayYearFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });

const $ = (sel) => document.querySelector(sel);

// ---------- Zustand ----------

let me = null; // { username, name, role: 'borrower' | 'lender', mustChangePassword }
let partner = null; // { username, name, role, passwordPending }
let entries = [];
let storage = null; // { type, location }

// ---------- Browser-Speicher (nur Cache und Hinweise) ----------

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Kein Speicher verfügbar (z. B. privater Modus) – die App funktioniert trotzdem.
  }
}

function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // egal
  }
}

// ---------- Server ----------

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(action, body) {
  let init = { cache: 'no-store' };
  if (body instanceof FormData) {
    init = { method: 'POST', headers: { 'X-Requested-With': 'schulden' }, body };
  } else if (body !== undefined) {
    init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'schulden' },
      body: JSON.stringify(body),
    };
  }
  let response;
  try {
    response = await fetch(`api/index.php?a=${action}`, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError('Keine Verbindung zum Server. Bist du online?', 0);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // keine JSON-Antwort
  }
  if (response.ok && data) return data;
  if (data?.error) throw new ApiError(data.error, response.status);
  if (response.status === 404) {
    throw new ApiError('Der Server-Teil der App (api/index.php) wurde nicht gefunden.', 404);
  }
  throw new ApiError(`Der Server antwortet nicht wie erwartet (Status ${response.status}). Läuft dort PHP?`, response.status);
}

/** Aktion ausführen, die den neuen Stand zurückliefert. */
async function send(action, body) {
  try {
    const data = await api(action, body);
    setOffline(false);
    if (data.user) applyState(data);
    return data;
  } catch (err) {
    if (err.status === 401 && me) sessionExpired();
    if (err.status === 0 && me) setOffline(true);
    throw err;
  }
}

function applyState(data, { fromCache = false } = {}) {
  me = data.user;
  partner = data.partner || null;
  entries = Array.isArray(data.entries) ? data.entries : [];
  storage = data.storage || null;
  if (fromCache) {
    // nichts speichern
  } else if (me.mustChangePassword) {
    removeKey(CACHE_KEY);
  } else {
    saveJSON(CACHE_KEY, { user: me, partner, entries, storage });
  }
  render();
}

/** Nach dem Anmelden: erst ein eigenes Passwort festlegen lassen, falls nötig, dann die App. */
function enterApp() {
  if (me.mustChangePassword) {
    const form = $('#own-password-form');
    form.elements.username.value = me.username;
    $('#own-password-text').textContent =
      `Hallo ${me.name}! Du hast dich mit einem Einmal-Passwort angemeldet. ` +
      'Lege jetzt dein eigenes Passwort fest – nur du kennst es.';
    showScreen('own-password');
    return;
  }
  showScreen('app');
  offerLegacyUpload();
  openShortcut();
}

/** Verknüpfung „Neuer Eintrag“ (langes Drücken auf das App-Icon) */
function openShortcut() {
  const params = new URLSearchParams(location.search);
  if (!params.has('neu')) return;
  history.replaceState(null, '', location.pathname);
  openEntrySheet('borrow');
}

async function logout() {
  await api('logout', {}).catch(() => {});
  clearSession();
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  showScreen('login');
  setFormError(loginForm, '');
}

function clearSession() {
  me = null;
  partner = null;
  entries = [];
  storage = null;
  removeKey(CACHE_KEY);
}

function sessionExpired() {
  clearSession();
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  showScreen('login');
  setFormError($('#login-form'), 'Du wurdest abgemeldet. Bitte melde dich erneut an.');
}

function setOffline(offline) {
  $('#offline-banner').hidden = !offline;
}

let loading = null;

/** Stand vom Server holen und passenden Bildschirm zeigen. */
function load() {
  loading ??= (async () => {
    let data;
    try {
      data = await api('state');
    } catch (err) {
      if (me) {
        setOffline(err.status === 0);
      } else {
        $('#auth-failed-text').textContent = err.message;
        showScreen('failed');
      }
      return;
    }
    setOffline(false);
    if (data.needsSetup) {
      clearSession();
      document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
      showScreen('setup');
      return;
    }
    if (!data.user) {
      if (me) sessionExpired();
      else showScreen('login');
      return;
    }
    applyState(data);
    enterApp();
  })().finally(() => {
    loading = null;
  });
  return loading;
}

// ---------- Hilfsfunktionen ----------

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

const signed = (e) => (e.dir === 'borrow' ? e.cents : -e.cents);
const formatEuro = (cents) => euro.format(cents / 100);
const centsToInput = (cents) => (cents / 100).toFixed(2).replace('.', ',');
const partnerName = () => partner?.name || 'der anderen Person';

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDay(iso) {
  if (iso === todayISO()) return 'Heute';
  if (iso === todayISO(-1)) return 'Gestern';
  const date = parseISODate(iso);
  return date.getFullYear() === new Date().getFullYear() ? dayFmt.format(date) : dayYearFmt.format(date);
}

/** Wandelt "12,50", "12.5", "1.234,56" oder "1000" in Cent um. Ungültig → NaN. */
function parseCents(input) {
  let s = String(input).replace(/[\s€]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}

/** Einträge chronologisch aufsteigend, jeweils mit Kontostand danach. */
function withRunningBalance() {
  let running = 0;
  return [...entries]
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)
    .map((e) => ({ ...e, running: (running += signed(e)) }));
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value);
  }
  el.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

/**
 * Beschriftungen aus Sicht der angemeldeten Person. Intern zählt jeder Betrag aus Sicht
 * der Person mit den Schulden: "borrow" erhöht die Schulden, "repay" verringert sie.
 */
function words() {
  const p = partnerName();
  if (me?.role === 'lender') {
    return {
      borrow: 'Verliehen',
      borrowTitle: 'Verliehen',
      borrowSub: `an ${p} gegeben`,
      repay: 'Zurückbekommen',
      repayTitle: 'Zurück\u00ADbekommen', // weiches Trennzeichen für schmale Bildschirme
      repaySub: `von ${p} bekommen`,
      borrowHint: `Du hast ${p} Geld gegeben oder etwas für ${p} bezahlt.`,
      repayHint: `${p} hat dir Geld zurückgegeben oder etwas für dich bezahlt.`,
      emptyHint: `Tippe auf „Verliehen“, wenn du ${p} Geld gibst oder etwas für ${p} bezahlst.`,
      positive: `${p} schuldet dir`,
      negative: `Du schuldest ${p}`,
    };
  }
  return {
    borrow: 'Geliehen',
    borrowTitle: 'Geliehen',
    borrowSub: `von ${p} bekommen`,
    repay: 'Zurückgezahlt',
    repayTitle: 'Zurück\u00ADgezahlt',
    repaySub: `an ${p} gegeben`,
    borrowHint: `${p} hat dir Geld gegeben oder etwas für dich bezahlt.`,
    repayHint: `Du hast ${p} Geld zurückgegeben oder etwas für ${p} bezahlt.`,
    emptyHint: `Tippe auf „Geliehen“, wenn dir ${p} Geld gibt oder etwas für dich bezahlt.`,
    positive: `Du schuldest ${p}`,
    negative: `${p} schuldet dir`,
  };
}

// ---------- Darstellung ----------

function showScreen(name) {
  $('#app').hidden = name !== 'app';
  $('#auth').hidden = name === 'app';
  $('#auth-status').hidden = name !== 'loading';
  $('#login-form').hidden = name !== 'login';
  $('#setup-form').hidden = name !== 'setup';
  $('#own-password-form').hidden = name !== 'own-password';
  $('#auth-failed').hidden = name !== 'failed';
  if (name === 'app') updateInstallUI();
}

function render() {
  if (!me) return;
  const w = words();
  document.querySelectorAll('[data-partner]').forEach((el) => (el.textContent = partnerName()));
  document.querySelectorAll('[data-word]').forEach((el) => (el.textContent = w[el.dataset.word]));

  let borrowed = 0;
  let repaid = 0;
  for (const e of entries) {
    if (e.dir === 'borrow') borrowed += e.cents;
    else repaid += e.cents;
  }
  const balance = borrowed - repaid;

  $('#balance-label').textContent = balance > 0 ? w.positive : balance < 0 ? w.negative : 'Ihr seid quitt';
  $('#balance-amount').textContent = formatEuro(Math.abs(balance));
  $('#balance-totals').textContent = entries.length
    ? `${w.borrow} ${formatEuro(borrowed)} · ${w.repay} ${formatEuro(repaid)}`
    : '';

  renderHistory(w);
}

function renderHistory(w) {
  const rows = withRunningBalance().reverse();
  $('#empty').hidden = rows.length > 0;

  const months = new Map();
  for (const e of rows) {
    const key = e.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(e);
  }

  const sections = [];
  for (const [key, list] of months) {
    const [y, m] = key.split('-').map(Number);
    sections.push(
      h(
        'section',
        { class: 'month' },
        h('h3', { class: 'month-head' }, monthFmt.format(new Date(y, m - 1, 1))),
        h('ul', { class: 'entries card' }, ...list.map((e) => renderEntry(e, w)))
      )
    );
  }
  $('#history').replaceChildren(...sections);
}

function renderEntry(e, w) {
  const dirLabel = e.dir === 'borrow' ? w.borrow : w.repay;
  const sign = e.dir === 'borrow' ? '+' : '−';
  const running = e.running < 0 ? `${w.negative} ${formatEuro(-e.running)}` : `Stand ${formatEuro(e.running)}`;
  const author = e.createdBy || '?';

  return h(
    'li',
    {},
    h(
      'button',
      { class: `entry ${e.dir}`, type: 'button', dataset: { id: e.id } },
      h('span', { class: 'entry-avatar', title: `Eingetragen von ${author}` }, Array.from(author)[0].toUpperCase()),
      h(
        'span',
        { class: 'entry-main' },
        h('span', { class: 'entry-note' }, e.note || dirLabel),
        h(
          'span',
          { class: 'entry-meta' },
          e.note ? `${formatDay(e.date)} · ${dirLabel}` : formatDay(e.date),
          e.photos?.length ? cameraIcon('entry-photo-icon', 'mit Beleg') : null,
          e.photos?.length > 1 ? ` ${e.photos.length}` : null
        )
      ),
      h(
        'span',
        { class: 'entry-right' },
        h('span', { class: 'entry-amount' }, `${sign}${formatEuro(e.cents)}`),
        h('span', { class: 'entry-running' }, running)
      )
    )
  );
}

function cameraIcon(className, label = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (className) svg.setAttribute('class', className);
  if (label) svg.setAttribute('aria-label', label);
  else svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>' +
    '<circle cx="12" cy="13" r="3"/>';
  return svg;
}

// ---------- Formulare ----------

function setFormError(form, message) {
  const el = form.querySelector('[data-error]');
  el.textContent = message || '';
  el.hidden = !message;
}

function setFormSuccess(form, message) {
  const el = form.querySelector('[data-success]');
  el.textContent = message || '';
  el.hidden = !message;
}

/** Sperrt die Buttons eines Formulars, solange die Anfrage läuft. */
async function whileBusy(form, task) {
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    return await task();
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---------- Toast ----------

let toastTimer;

function showToast(text, { action, onAction, duration = 2500 } = {}) {
  const toast = $('#toast');
  const button = $('#toast-action');
  $('#toast-text').textContent = text;
  button.hidden = !action;
  button.textContent = action || '';
  button.onclick = () => {
    hideToast();
    onAction?.();
  };
  toast.hidden = false;
  clearTimeout(toastTimer);
  if (Number.isFinite(duration)) toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').hidden = true;
}

function undoToast(text, ids) {
  showToast(text, {
    action: 'Rückgängig',
    duration: 8000,
    onAction: () => send('restore', { ids }).catch((err) => alert(err.message)),
  });
}

// ---------- Anmelden und Einrichten ----------

const loginForm = $('#login-form');
const setupForm = $('#setup-form');

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = loginForm.elements;
  setFormError(loginForm, '');
  try {
    await whileBusy(loginForm, () => send('login', { username: f.username.value, password: f.password.value }));
  } catch (err) {
    setFormError(loginForm, err.message);
    return;
  }
  loginForm.reset();
  enterApp();
});

setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = setupForm.elements;
  const oneTimePassword = f.partner_password.value;
  setFormError(setupForm, '');
  try {
    await whileBusy(setupForm, () =>
      send('setup', {
        role: f.role.value,
        me: { name: f.me_name.value, username: f.me_username.value, password: f.me_password.value },
        partner: { name: f.partner_name.value, username: f.partner_username.value, password: f.partner_password.value },
      })
    );
  } catch (err) {
    setFormError(setupForm, err.message);
    return;
  }
  setupForm.reset();
  enterApp();
  openShareSheet(partner, oneTimePassword);
});

// Benutzernamen aus dem Namen vorschlagen, solange man ihn nicht selbst ändert.
function suggestUsername(name) {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 30);
}

for (const prefix of ['me', 'partner']) {
  const nameInput = setupForm.elements[`${prefix}_name`];
  const userInput = setupForm.elements[`${prefix}_username`];
  userInput.addEventListener('input', () => (userInput.dataset.touched = userInput.value ? '1' : ''));
  nameInput.addEventListener('input', () => {
    if (!userInput.dataset.touched) userInput.value = suggestUsername(nameInput.value);
  });
}

const ownPasswordForm = $('#own-password-form');

ownPasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = ownPasswordForm.elements;
  setFormError(ownPasswordForm, '');
  if (f.new.value !== f.repeat.value) {
    setFormError(ownPasswordForm, 'Die beiden Passwörter sind nicht gleich.');
    return;
  }
  try {
    await whileBusy(ownPasswordForm, () => send('password', { new: f.new.value }));
  } catch (err) {
    if (err.status !== 401) setFormError(ownPasswordForm, err.message);
    return;
  }
  ownPasswordForm.reset();
  enterApp();
  showToast('Dein Passwort ist gespeichert');
});

$('#own-password-logout').addEventListener('click', logout);

$('#auth-retry').addEventListener('click', () => {
  showScreen('loading');
  load();
});

/** Einträge aus der ersten Version (nur im Browser gespeichert) einmalig hochladen. */
let legacyOffered = false;

async function offerLegacyUpload() {
  if (legacyOffered) return;
  legacyOffered = true;
  const legacy = loadJSON(LEGACY_KEY, null);
  if (!Array.isArray(legacy) || legacy.length === 0 || loadJSON(LEGACY_DECLINED_KEY, false)) return;

  const count = legacy.length === 1 ? 'ist noch 1 Eintrag' : `sind noch ${legacy.length} Einträge`;
  const ok = confirm(
    `Auf diesem Gerät ${count} aus der Version ohne Login gespeichert.\n\n` +
      `Jetzt auf den Server hochladen, damit ${partnerName()} ${legacy.length === 1 ? 'ihn' : 'sie'} auch sieht?`
  );
  if (!ok) {
    saveJSON(LEGACY_DECLINED_KEY, true);
    return;
  }
  try {
    const data = await send('import', { entries: legacy });
    removeKey(LEGACY_KEY);
    showToast(`${data.added + data.restored} Einträge hochgeladen`);
  } catch (err) {
    legacyOffered = false;
    alert(`Hochladen hat nicht geklappt: ${err.message}`);
  }
}

// ---------- Eintrag hinzufügen / bearbeiten ----------

const entrySheet = $('#entry-sheet');
const entryForm = $('#entry-form');
const amountInput = $('#amount');
let currentId = null;
let isNewEntry = true;
let savedEntryKey = null; // Stand, der schon auf dem Server ist
let sheetPhotos = []; // { id, url, existing, blob?, removed?, done? }

function openEntrySheet(dir, entry = null) {
  // Neue Einträge bekommen ihre ID schon jetzt, damit ein erneutes Senden nach
  // einem Verbindungsfehler nichts doppelt anlegt.
  currentId = entry ? entry.id : newId();
  isNewEntry = !entry;
  entryForm.reset();
  entryForm.elements.dir.value = entry ? entry.dir : dir;
  amountInput.value = entry ? centsToInput(entry.cents) : '';
  $('#note').value = entry ? entry.note : '';
  $('#date').value = entry ? entry.date : todayISO();
  $('#entry-title').textContent = entry ? 'Eintrag bearbeiten' : 'Neuer Eintrag';
  $('#delete-entry').hidden = !entry;
  savedEntryKey = entry ? entryKey(entry) : null;
  sheetPhotos = (entry?.photos || []).map((photo) => ({ id: photo.id, url: photoUrl(photo.id), existing: true }));
  renderPhotos();

  const info = $('#entry-info');
  info.hidden = !entry;
  if (entry) {
    const created = entry.createdAt > 0 ? ` am ${dayYearFmt.format(new Date(entry.createdAt))}` : '';
    const updated = entry.updatedBy ? ` · zuletzt geändert von ${entry.updatedBy}` : '';
    info.textContent = `Eingetragen von ${entry.createdBy || 'unbekannt'}${created}${updated}`;
  }

  setAmountError(false);
  setFormError(entryForm, '');
  updateDirHint();
  hideToast();
  entrySheet.showModal();
  if (!entry) amountInput.focus();
}

function updateDirHint() {
  const w = words();
  $('#dir-hint').textContent = entryForm.elements.dir.value === 'borrow' ? w.borrowHint : w.repayHint;
}

function setAmountError(show) {
  $('#amount-error').hidden = !show;
  amountInput.setAttribute('aria-invalid', String(show));
}

entryForm.addEventListener('change', (event) => {
  if (event.target.name === 'dir') updateDirHint();
});

amountInput.addEventListener('input', () => setAmountError(false));

const photoUrl = (id) => `api/index.php?a=photo&id=${encodeURIComponent(id)}`;
const entryKey = (e) => JSON.stringify([e.id, e.dir, e.cents, e.note, e.date]);
const visiblePhotos = () => sheetPhotos.filter((photo) => !photo.removed);

function renderPhotos() {
  const tiles = visiblePhotos().map((photo) =>
    h(
      'div',
      { class: 'photo' },
      h('button', { class: 'photo-open', type: 'button', 'aria-label': 'Beleg ansehen', dataset: { open: photo.id } }, h('img', { src: photo.url, alt: '' })),
      h('button', { class: 'photo-remove', type: 'button', 'aria-label': 'Beleg entfernen', dataset: { remove: photo.id } }, '×')
    )
  );
  if (tiles.length < MAX_PHOTOS) {
    tiles.push(h('button', { class: 'photo-add', type: 'button', dataset: { add: 'photo' } }, cameraIcon(), 'Foto'));
  }
  $('#photo-list').replaceChildren(...tiles);
}

$('#photo-list').addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.add) {
    $('#photo-input').click();
    return;
  }
  const photo = sheetPhotos.find((p) => p.id === (target.dataset.open || target.dataset.remove));
  if (!photo) return;
  if (target.dataset.open) {
    openViewer(photo.url);
  } else if (photo.existing) {
    photo.removed = true; // wird beim Sichern gelöscht
    renderPhotos();
  } else {
    URL.revokeObjectURL(photo.url);
    sheetPhotos = sheetPhotos.filter((p) => p !== photo);
    renderPhotos();
  }
});

$('#photo-input').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  setFormError(entryForm, '');
  const free = MAX_PHOTOS - visiblePhotos().length;
  if (files.length > free) setFormError(entryForm, `Höchstens ${MAX_PHOTOS} Fotos pro Eintrag.`);
  for (const file of files.slice(0, free)) {
    try {
      const blob = await shrinkImage(file);
      sheetPhotos.push({ id: newId(), url: URL.createObjectURL(blob), blob, existing: false });
      renderPhotos();
    } catch (err) {
      setFormError(entryForm, err.message);
    }
  }
});

/**
 * Fotos vor dem Hochladen verkleinern (Handyfotos haben oft 5–10 MB). Nebenbei fallen dabei
 * die Zusatzdaten im Foto weg, z. B. der Aufnahmeort.
 */
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) throw new Error('toBlob');
    return blob;
  } catch {
    throw new Error(`„${file.name}“ konnte nicht als Bild gelesen werden.`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

entrySheet.addEventListener('close', () => {
  for (const photo of sheetPhotos) {
    if (photo.blob) URL.revokeObjectURL(photo.url);
  }
  sheetPhotos = [];
});

const viewer = $('#viewer');

function openViewer(url) {
  $('#viewer-img').src = url;
  viewer.showModal();
}

viewer.addEventListener('click', () => viewer.close());

/** Eintrag sichern, danach entfernte Fotos löschen und neue hochladen. */
async function saveEntryWithPhotos(entry) {
  const key = entryKey(entry);
  if (key !== savedEntryKey) {
    await send('save', entry);
    savedEntryKey = key;
  }
  for (const photo of sheetPhotos.filter((p) => p.existing && p.removed && !p.done)) {
    await send('photo-delete', { id: photo.id });
    photo.done = true;
  }
  const uploads = sheetPhotos.filter((p) => !p.existing && !p.done);
  const button = entryForm.querySelector('.sheet-body button[type=submit]');
  try {
    for (const [index, photo] of uploads.entries()) {
      button.textContent = uploads.length > 1 ? `Foto ${index + 1} von ${uploads.length} wird hochgeladen …` : 'Foto wird hochgeladen …';
      const form = new FormData();
      form.append('id', photo.id);
      form.append('entry', entry.id);
      form.append('photo', photo.blob, `${photo.id}.jpg`);
      await send('photo-upload', form);
      photo.done = true;
    }
  } finally {
    button.textContent = 'Sichern';
  }
}

entryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const cents = parseCents(amountInput.value);
  if (!(cents > 0 && cents <= MAX_CENTS)) {
    setAmountError(true);
    amountInput.focus();
    return;
  }
  const dateValue = $('#date').value;
  const entry = {
    id: currentId,
    dir: entryForm.elements.dir.value,
    cents,
    note: $('#note').value.trim(),
    date: /^\d{4}-\d{2}-\d{2}$/.test(dateValue) ? dateValue : todayISO(),
  };

  setFormError(entryForm, '');
  try {
    await whileBusy(entryForm, () => saveEntryWithPhotos(entry));
  } catch (err) {
    if (err.status !== 401) setFormError(entryForm, err.message);
    return;
  }
  entrySheet.close();
  showToast(isNewEntry ? 'Eintrag gespeichert' : 'Änderung gespeichert');
});

$('#delete-entry').addEventListener('click', async () => {
  const id = currentId;
  setFormError(entryForm, '');
  try {
    await whileBusy(entryForm, () => send('delete', { id }));
  } catch (err) {
    if (err.status !== 401) setFormError(entryForm, err.message);
    return;
  }
  entrySheet.close();
  undoToast('Eintrag gelöscht', [id]);
});

document.querySelectorAll('[data-add]').forEach((button) => {
  button.addEventListener('click', () => openEntrySheet(button.dataset.add));
});

$('#history').addEventListener('click', (event) => {
  const button = event.target.closest('.entry');
  const entry = button && entries.find((e) => e.id === button.dataset.id);
  if (entry) openEntrySheet(entry.dir, entry);
});

// Schließen-Buttons und Tippen auf den abgedunkelten Hintergrund
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => dialog.close());
  });
});

// ---------- Einstellungen ----------

const settingsSheet = $('#settings-sheet');
const passwordForm = $('#password-form');
const partnerPasswordForm = $('#partner-password-form');

$('#open-settings').addEventListener('click', () => {
  $('#me-name').textContent = me.name;
  $('#me-username').textContent = me.username;
  $('#storage-text').textContent = storage
    ? `Eure Einträge liegen auf eurem Server (${storage.type}: ${storage.location}). ` +
      `${me.name} und ${partnerName()} sehen dieselben Daten. Fotos von Belegen liegen im Ordner ${storage.photos}. ` +
      'Ein Backup als Datei schadet trotzdem nicht (es enthält die Einträge, aber keine Fotos).'
    : '';
  $('#partner-status').textContent = partner
    ? partner.passwordPending
      ? `${partner.name} hat sich noch nicht angemeldet bzw. das Einmal-Passwort noch nicht durch ein eigenes ersetzt.`
      : `${partner.name} hat ein eigenes Passwort, das nur ${partner.name} kennt.`
    : '';
  for (const form of [passwordForm, partnerPasswordForm]) {
    form.reset();
    setFormError(form, '');
    form.closest('details').open = false;
  }
  $('#ntfy-details').open = false;
  fillNtfyForm();
  updateInstallUI();
  hideToast();
  settingsSheet.showModal();
});

$('#logout').addEventListener('click', logout);

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = passwordForm.elements;
  setFormError(passwordForm, '');
  try {
    await whileBusy(passwordForm, () => send('password', { current: f.current.value, new: f.new.value }));
  } catch (err) {
    if (err.status !== 401) setFormError(passwordForm, err.message);
    return;
  }
  settingsSheet.close();
  showToast('Passwort geändert');
});

partnerPasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = partnerPasswordForm.elements;
  const oneTimePassword = f.new.value;
  setFormError(partnerPasswordForm, '');
  try {
    await whileBusy(partnerPasswordForm, () => send('partner-password', { current: f.current.value, new: oneTimePassword }));
  } catch (err) {
    if (err.status !== 401) setFormError(partnerPasswordForm, err.message);
    return;
  }
  settingsSheet.close();
  openShareSheet(partner, oneTimePassword);
});

// ---------- Benachrichtigungen (ntfy) ----------

const ntfyForm = $('#ntfy-form');
const ntfyConfig = () => me?.ntfy || { topic: '', server: '', hasToken: false };

/** Zufälliger Kanalname – bei ntfy.sh kann jeder mitlesen, der den Namen kennt. */
function randomTopic() {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 12);
  return `schulden-${me.username.replace(/[^A-Za-z0-9_-]/g, '-')}-${random}`;
}

function updateNtfyUI() {
  const config = ntfyConfig();
  const active = Boolean(config.topic);
  const p = partnerName();
  const partnerText = !partner
    ? ''
    : partner.notifications
      ? ` ${p} bekommt auch Benachrichtigungen.`
      : ` ${p} hat sie noch nicht eingeschaltet.`;
  $('#ntfy-status').textContent =
    (active
      ? `Eingeschaltet: Du bekommst über ntfy eine Push-Nachricht, wenn ${p} etwas einträgt, ändert oder löscht.`
      : `Bekomme eine Push-Nachricht aufs Handy, wenn ${p} etwas einträgt, ändert oder löscht – über die kostenlose App ntfy.`) +
    partnerText;
  $('#ntfy-summary').textContent = active ? 'Einstellungen und Test' : 'Einrichten';
  $('#ntfy-test').hidden = !active;
  $('#ntfy-off').hidden = !active;
  ntfyForm.elements.token.placeholder = config.hasToken ? 'gespeichert – leer lassen zum Behalten' : 'nur bei geschützten Kanälen';
}

function fillNtfyForm() {
  const config = ntfyConfig();
  const f = ntfyForm.elements;
  f.topic.value = config.topic || randomTopic();
  f.server.value = config.server || '';
  f.token.value = '';
  ntfyForm.querySelector('.advanced').open = Boolean(config.server || config.hasToken);
  $('#ntfy-copy').textContent = 'Kopieren';
  setFormError(ntfyForm, '');
  setFormSuccess(ntfyForm, '');
  updateNtfyUI();
}

function saveNtfy() {
  const f = ntfyForm.elements;
  return send('ntfy-save', { topic: f.topic.value, server: f.server.value, token: f.token.value });
}

ntfyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormError(ntfyForm, '');
  setFormSuccess(ntfyForm, '');
  try {
    await whileBusy(ntfyForm, saveNtfy);
  } catch (err) {
    if (err.status !== 401) setFormError(ntfyForm, err.message);
    return;
  }
  ntfyForm.elements.token.value = '';
  updateNtfyUI();
  setFormSuccess(ntfyForm, 'Gespeichert. Schick jetzt eine Test-Nachricht, um zu prüfen, ob sie ankommt.');
});

$('#ntfy-test').addEventListener('click', async () => {
  setFormError(ntfyForm, '');
  setFormSuccess(ntfyForm, '');
  try {
    // Erst den aktuellen Stand des Formulars speichern, damit der Test an den richtigen Kanal geht.
    await whileBusy(ntfyForm, async () => {
      await saveNtfy();
      await api('ntfy-test', {});
    });
  } catch (err) {
    if (err.status !== 401) setFormError(ntfyForm, err.message);
    return;
  }
  ntfyForm.elements.token.value = '';
  updateNtfyUI();
  setFormSuccess(ntfyForm, 'Test-Nachricht ist raus. Kommt sie nicht an: Ist der Kanal in der ntfy-App genau so eingetragen?');
});

$('#ntfy-off').addEventListener('click', async () => {
  setFormError(ntfyForm, '');
  try {
    await whileBusy(ntfyForm, () => send('ntfy-save', { topic: '' }));
  } catch (err) {
    if (err.status !== 401) setFormError(ntfyForm, err.message);
    return;
  }
  fillNtfyForm();
  setFormSuccess(ntfyForm, 'Benachrichtigungen sind aus. Den Kanal kannst du in der ntfy-App wieder entfernen.');
});

$('#ntfy-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(ntfyForm.elements.topic.value);
    $('#ntfy-copy').textContent = 'Kopiert ✓';
  } catch {
    ntfyForm.elements.topic.select();
  }
});

// ---------- Zugangsdaten an die andere Person schicken ----------

const shareSheet = $('#share-sheet');

function openShareSheet(person, oneTimePassword) {
  if (!person) return;
  const appUrl = location.origin + location.pathname.replace(/index\.html$/, '');
  const text =
    `Hallo ${person.name}! Hier ist unsere Schulden-App:\n${appUrl}\n\n` +
    `Benutzername: ${person.username}\nEinmal-Passwort: ${oneTimePassword}\n\n` +
    'Beim ersten Anmelden legst du dein eigenes Passwort fest. ' +
    'Tipp: Über „Teilen → Zum Home-Bildschirm“ wird daraus eine App.';
  $('#share-name').textContent = person.name;
  document.querySelectorAll('.share-name').forEach((el) => (el.textContent = person.name));
  $('#share-text').textContent = text;
  $('#share-send').hidden = !navigator.share;
  $('#share-copy').textContent = 'Text kopieren';
  shareSheet.showModal();
}

$('#share-send').addEventListener('click', () => {
  navigator.share({ text: $('#share-text').textContent }).catch(() => {});
});

$('#share-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#share-text').textContent);
    $('#share-copy').textContent = 'Kopiert ✓';
  } catch {
    $('#share-copy').textContent = 'Kopieren ging nicht – bitte Text markieren';
  }
});

function backupFilename(ext) {
  return `schulden-${ext === 'csv' ? 'export' : 'backup'}-${todayISO()}.${ext}`;
}

async function shareOrDownload(filename, content, type) {
  const blob = new Blob([content], { type });
  const file = new File([blob], filename, { type });

  // Auf dem Handy über das Teilen-Menü (z. B. „In Dateien sichern“), sonst normaler Download.
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#export-json').addEventListener('click', () => {
  const backup = {
    app: 'schulden',
    version: 2,
    exportedAt: new Date().toISOString(),
    users: [me, partner].filter(Boolean),
    entries,
  };
  shareOrDownload(backupFilename('json'), JSON.stringify(backup, null, 2), 'application/json');
});

$('#export-csv').addEventListener('click', () => {
  const w = words();
  const num = (cents) => (cents / 100).toFixed(2).replace('.', ',');
  const cell = (value) => (/[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const rows = [['Datum', 'Art', 'Betrag (€)', 'Notiz', 'Stand (€)', 'Eingetragen von']];
  for (const e of withRunningBalance()) {
    const [y, m, d] = e.date.split('-');
    rows.push([
      `${d}.${m}.${y}`,
      e.dir === 'borrow' ? w.borrow : w.repay,
      num(signed(e)),
      e.note,
      num(e.running),
      e.createdBy || '',
    ]);
  }
  // BOM + Semikolon, damit Excel mit deutschen Einstellungen die Datei direkt richtig öffnet.
  const csv = '﻿' + rows.map((row) => row.map(cell).join(';')).join('\r\n');
  shareOrDownload(backupFilename('csv'), csv, 'text/csv');
});

$('#import-json').addEventListener('click', () => $('#import-file').click());

$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;

  let list;
  try {
    const data = JSON.parse(await file.text());
    list = Array.isArray(data) ? data : data?.entries;
    if (!Array.isArray(list)) throw new Error('Kein Backup');
  } catch {
    alert('Die Datei konnte nicht gelesen werden. Ist es ein Backup aus dieser App?');
    return;
  }

  const count = list.length === 1 ? '1 Eintrag' : `${list.length} Einträge`;
  if (!confirm(`Backup mit ${count} einspielen?\n\nFehlende Einträge kommen dazu, vorhandene bleiben unverändert.`)) {
    return;
  }
  let data;
  try {
    data = await send('import', { entries: list });
  } catch (err) {
    alert(`Einspielen hat nicht geklappt: ${err.message}`);
    return;
  }
  settingsSheet.close();
  const changed = data.added + data.restored;
  showToast(changed ? `${changed} ${changed === 1 ? 'Eintrag' : 'Einträge'} hinzugefügt` : 'Alle Einträge waren schon da');
});

$('#delete-all').addEventListener('click', async () => {
  if (!entries.length) {
    alert('Es gibt keine Einträge zum Löschen.');
    return;
  }
  if (!confirm(`Wirklich alle ${entries.length} Einträge löschen? Sie verschwinden auch bei ${partnerName()}.`)) return;
  let data;
  try {
    data = await send('delete-all', {});
  } catch (err) {
    if (err.status !== 401) alert(err.message);
    return;
  }
  settingsSheet.close();
  undoToast('Alle Einträge gelöscht', data.deletedIds || []);
});

// ---------- Zum Home-Bildschirm hinzufügen ----------

const SHARE_ICON =
  '<svg class="share-icon" viewBox="0 0 24 24" aria-label="Teilen-Symbol"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2"/></svg>';

const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installPrompt = null;

function installText() {
  if (installPrompt) {
    return 'Dann startet sie wie eine normale App vom Home-Bildschirm.';
  }
  if (isIOS) {
    return (
      `Tippe auf ${SHARE_ICON} <b>Teilen</b> und dann auf <b>„Zum Home-Bildschirm“</b>. ` +
      'Danach meldest du dich in der App einmal neu an.'
    );
  }
  return 'Öffne das Browser-Menü (⋮) und tippe auf <b>„App installieren“</b> bzw. <b>„Zum Startbildschirm hinzufügen“</b>.';
}

function updateInstallUI() {
  const installed = isStandalone();
  const dismissed = loadJSON(HINT_KEY, false);
  const mobile = matchMedia('(pointer: coarse)').matches;

  $('#install-hint').hidden = installed || dismissed || !(mobile || installPrompt);
  $('#install-hint-text').innerHTML = installText();
  $('#install-btn').hidden = !installPrompt;

  $('#install-section').hidden = installed;
  $('#install-section-text').innerHTML = installText();
  $('#install-btn-settings').hidden = !installPrompt;
}

async function promptInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  updateInstallUI();
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  updateInstallUI();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  updateInstallUI();
});

$('#install-btn').addEventListener('click', promptInstall);
$('#install-btn-settings').addEventListener('click', promptInstall);
$('#install-dismiss').addEventListener('click', () => {
  saveJSON(HINT_KEY, true);
  updateInstallUI();
});

// ---------- Offline-Unterstützung ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      showToast('Neue Version verfügbar', { action: 'Neu laden', duration: Infinity, onAction: () => location.reload() });
    });
  });
}

// ---------- Start ----------

// Sofort den letzten bekannten Stand zeigen, dann vom Server aktualisieren.
const cached = loadJSON(CACHE_KEY, null);
if (cached?.user && !cached.user.mustChangePassword) {
  applyState(cached, { fromCache: true });
  showScreen('app');
} else {
  showScreen('loading');
}
load();

// Änderungen der anderen Person holen, sobald die App wieder in den Vordergrund kommt.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && me) load();
});
window.addEventListener('online', () => {
  if (me) load();
});
