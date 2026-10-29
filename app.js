'use strict';

const ENTRIES_KEY = 'schulden.entries.v1';
const SETTINGS_KEY = 'schulden.settings.v1';
const HINT_KEY = 'schulden.installHintDismissed';
const DEFAULT_NAME = 'Papa';
const MAX_CENTS = 100_000_000_00; // 100 Mio. €

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const dayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
const dayYearFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });

const $ = (sel) => document.querySelector(sel);

// ---------- Speicher ----------

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
    return true;
  } catch {
    alert('Speichern hat nicht geklappt. Ist der Speicher voll oder der private Modus aktiv?');
    return false;
  }
}

function isValidEntry(e) {
  return (
    e !== null &&
    typeof e === 'object' &&
    (e.dir === 'borrow' || e.dir === 'repay') &&
    Number.isInteger(e.cents) &&
    e.cents > 0 &&
    e.cents <= MAX_CENTS &&
    typeof e.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(e.date)
  );
}

function normalizeEntry(e) {
  return {
    id: typeof e.id === 'string' && e.id ? e.id : newId(),
    dir: e.dir,
    cents: e.cents,
    date: e.date,
    note: typeof e.note === 'string' ? e.note.slice(0, 120) : '',
    createdAt: Number.isFinite(e.createdAt) ? e.createdAt : 0,
  };
}

function loadEntries() {
  const list = loadJSON(ENTRIES_KEY, []);
  return Array.isArray(list) ? list.filter(isValidEntry).map(normalizeEntry) : [];
}

function loadSettings() {
  const stored = loadJSON(SETTINGS_KEY, {});
  const name = typeof stored?.name === 'string' && stored.name.trim() ? stored.name.trim() : DEFAULT_NAME;
  return { name };
}

let entries = loadEntries();
let settings = loadSettings();

const persistEntries = () => saveJSON(ENTRIES_KEY, entries);
const persistSettings = () => saveJSON(SETTINGS_KEY, settings);

// ---------- Hilfsfunktionen ----------

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

const signed = (e) => (e.dir === 'borrow' ? e.cents : -e.cents);
const formatEuro = (cents) => euro.format(cents / 100);
const centsToInput = (cents) => (cents / 100).toFixed(2).replace('.', ',');

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

// ---------- Darstellung ----------

function render() {
  const { name } = settings;
  document.querySelectorAll('[data-name]').forEach((el) => (el.textContent = name));

  let borrowed = 0;
  let repaid = 0;
  for (const e of entries) {
    if (e.dir === 'borrow') borrowed += e.cents;
    else repaid += e.cents;
  }
  const balance = borrowed - repaid;

  $('#balance-label').textContent =
    balance > 0 ? `Du schuldest ${name}` : balance < 0 ? `${name} schuldet dir` : 'Ihr seid quitt';
  $('#balance-amount').textContent = formatEuro(Math.abs(balance));
  $('#balance-totals').textContent = entries.length
    ? `Geliehen ${formatEuro(borrowed)} · Zurückgezahlt ${formatEuro(repaid)}`
    : '';

  renderHistory();
}

function renderHistory() {
  const history = $('#history');
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
        h('ul', { class: 'entries card' }, ...list.map(renderEntry))
      )
    );
  }
  history.replaceChildren(...sections);
}

function renderEntry(e) {
  const dirLabel = e.dir === 'borrow' ? 'Geliehen' : 'Zurückgezahlt';
  const sign = e.dir === 'borrow' ? '+' : '−';
  const running = e.running < 0 ? `${settings.name} schuldet dir ${formatEuro(-e.running)}` : `Stand ${formatEuro(e.running)}`;

  return h(
    'li',
    {},
    h(
      'button',
      { class: `entry ${e.dir}`, type: 'button', dataset: { id: e.id } },
      h('span', { class: 'entry-dot', 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'entry-main' },
        h('span', { class: 'entry-note' }, e.note || dirLabel),
        h('span', { class: 'entry-meta' }, e.note ? `${formatDay(e.date)} · ${dirLabel}` : formatDay(e.date))
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

// ---------- Eintrag hinzufügen / bearbeiten ----------

const entrySheet = $('#entry-sheet');
const entryForm = $('#entry-form');
const amountInput = $('#amount');
let editingId = null;

function openEntrySheet(dir, entry = null) {
  editingId = entry ? entry.id : null;
  entryForm.reset();
  entryForm.elements.dir.value = entry ? entry.dir : dir;
  amountInput.value = entry ? centsToInput(entry.cents) : '';
  $('#note').value = entry ? entry.note : '';
  $('#date').value = entry ? entry.date : todayISO();
  $('#entry-title').textContent = entry ? 'Eintrag bearbeiten' : 'Neuer Eintrag';
  $('#delete-entry').hidden = !entry;
  setAmountError(false);
  updateDirHint();
  hideToast();
  entrySheet.showModal();
  if (!entry) amountInput.focus();
}

function updateDirHint() {
  const { name } = settings;
  $('#dir-hint').textContent =
    entryForm.elements.dir.value === 'borrow'
      ? `${name} hat dir Geld gegeben oder etwas für dich bezahlt.`
      : `Du hast ${name} Geld zurückgegeben oder etwas für ${name} bezahlt.`;
}

function setAmountError(show) {
  $('#amount-error').hidden = !show;
  amountInput.setAttribute('aria-invalid', String(show));
}

entryForm.addEventListener('change', (event) => {
  if (event.target.name === 'dir') updateDirHint();
});

amountInput.addEventListener('input', () => setAmountError(false));

entryForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const cents = parseCents(amountInput.value);
  if (!(cents > 0 && cents <= MAX_CENTS)) {
    setAmountError(true);
    amountInput.focus();
    return;
  }
  const dateValue = $('#date').value;
  const data = {
    dir: entryForm.elements.dir.value,
    cents,
    note: $('#note').value.trim(),
    date: /^\d{4}-\d{2}-\d{2}$/.test(dateValue) ? dateValue : todayISO(),
  };

  const wasEditing = Boolean(editingId);
  if (wasEditing) {
    entries = entries.map((e) => (e.id === editingId ? { ...e, ...data } : e));
  } else {
    entries.push({ id: newId(), createdAt: Date.now(), ...data });
  }
  persistEntries();
  render();
  entrySheet.close();
  showToast(wasEditing ? 'Änderung gespeichert' : 'Eintrag gespeichert');
});

$('#delete-entry').addEventListener('click', () => {
  const removed = entries.find((e) => e.id === editingId);
  if (!removed) return;
  entries = entries.filter((e) => e !== removed);
  persistEntries();
  render();
  entrySheet.close();
  showToast('Eintrag gelöscht', {
    action: 'Rückgängig',
    duration: 6000,
    onAction: () => {
      entries.push(removed);
      persistEntries();
      render();
    },
  });
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
const nameInput = $('#person-name');

$('#open-settings').addEventListener('click', () => {
  nameInput.value = settings.name;
  updateInstallUI();
  hideToast();
  settingsSheet.showModal();
});

nameInput.addEventListener('input', () => {
  settings.name = nameInput.value.trim() || DEFAULT_NAME;
  persistSettings();
  render();
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
  const backup = { app: 'schulden', version: 1, exportedAt: new Date().toISOString(), settings, entries };
  shareOrDownload(backupFilename('json'), JSON.stringify(backup, null, 2), 'application/json');
});

$('#export-csv').addEventListener('click', () => {
  const num = (cents) => (cents / 100).toFixed(2).replace('.', ',');
  const cell = (value) => (/[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const rows = [['Datum', 'Art', 'Betrag (€)', 'Notiz', 'Stand (€)']];
  for (const e of withRunningBalance()) {
    const [y, m, d] = e.date.split('-');
    rows.push([`${d}.${m}.${y}`, e.dir === 'borrow' ? 'Geliehen' : 'Zurückgezahlt', num(signed(e)), e.note, num(e.running)]);
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

  let imported;
  let importedName;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data?.entries;
    if (!Array.isArray(list)) throw new Error('Kein Backup');
    imported = list.filter(isValidEntry).map(normalizeEntry);
    if (list.length > 0 && imported.length === 0) throw new Error('Keine gültigen Einträge');
    importedName = typeof data?.settings?.name === 'string' ? data.settings.name.trim() : '';
  } catch {
    alert('Die Datei konnte nicht gelesen werden. Ist es ein Backup aus dieser App?');
    return;
  }

  const question =
    `Backup mit ${imported.length} ${imported.length === 1 ? 'Eintrag' : 'Einträgen'} wiederherstellen?` +
    (entries.length ? `\n\nDie ${entries.length} Einträge auf diesem Gerät werden dabei ersetzt.` : '');
  if (!confirm(question)) return;

  entries = imported;
  if (importedName) settings.name = importedName;
  persistEntries();
  persistSettings();
  render();
  settingsSheet.close();
  showToast('Backup wiederhergestellt');
});

$('#delete-all').addEventListener('click', () => {
  if (!entries.length) {
    alert('Es gibt keine Einträge zum Löschen.');
    return;
  }
  if (!confirm(`Wirklich alle ${entries.length} Einträge löschen?`)) return;
  const previous = entries;
  entries = [];
  persistEntries();
  render();
  settingsSheet.close();
  showToast('Alle Einträge gelöscht', {
    action: 'Rückgängig',
    duration: 8000,
    onAction: () => {
      entries = previous;
      persistEntries();
      render();
    },
  });
});

// Änderungen aus einem anderen Tab übernehmen
window.addEventListener('storage', (event) => {
  if (event.key === ENTRIES_KEY) entries = loadEntries();
  if (event.key === SETTINGS_KEY) settings = loadSettings();
  render();
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
    return 'Dann startet sie wie eine normale App vom Home-Bildschirm und funktioniert auch offline.';
  }
  if (isIOS) {
    return (
      `Tippe auf ${SHARE_ICON} <b>Teilen</b> und dann auf <b>„Zum Home-Bildschirm“</b>. ` +
      'Am besten vor dem ersten Eintrag: Die App auf dem Home-Bildschirm hat einen eigenen Speicher, ' +
      'Einträge aus Safari musst du sonst per Backup übertragen.'
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

// Bittet den Browser, die Daten nicht automatisch zu löschen (v. a. bei installierter App).
navigator.storage?.persist?.().catch(() => {});

render();
updateInstallUI();
