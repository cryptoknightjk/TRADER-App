/**
 * CSV journal persistence (portable plain-text trades file).
 *
 * - Desktop: journals live in journals/*.csv next to the app.
 * - Browser fallback: IndexedDB snapshot + optional download/import.
 * - Excel import (desktop) converts .xlsx → .csv via native API.
 */

const IDB_NAME = "cts-trading-hub-csv";
const IDB_VERSION = 1;
const STORE_HANDLES = "handles";
const STORE_DATA = "data";
const HANDLE_KEY = "journal";
const TEXT_KEY = "csvText";
const META_KEY = "meta";
const LS_LAST_DB = "ctsHubLastDbCsv";

/** @type {Array<Record<string, any>>|null} */
let trades = null;
let nextId = 1;
/** @type {{ name: string|null, mode: 'idb' | 'file', nativePath?: string|null }} */
let meta = { name: null, mode: "idb", nativePath: null };
let fileHandle = null;
let nativePath = null;

export const CSV_COLUMNS = [
  "id",
  "entry_date",
  "pair",
  "direction",
  "entry_price",
  "stop_loss",
  "take_profit",
  "strategy",
  "setup_idea",
  "quality",
  "exit_reason",
  "exit_date",
  "exit_price",
  "notes",
  "archived",
  "created_at",
];

export const BUNDLED_JOURNAL_FILE = "default_journal.csv";
export const JOURNAL_DIR = "journals";
const BUNDLED_JOURNAL_URL = `${JOURNAL_DIR}/${BUNDLED_JOURNAL_FILE}`;

function isNativeDesktop() {
  return !!(window.pywebview && window.pywebview.api
    && typeof window.pywebview.api.write_file === "function");
}

function waitForNativeApi(timeoutMs = 4000) {
  if (isNativeDesktop()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (isNativeDesktop()) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 50);
    };
    window.addEventListener("pywebviewready", () => {
      if (isNativeDesktop()) resolve(true);
    }, { once: true });
    tick();
  });
}

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToText(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function fileNameFromPath(path) {
  if (!path) return "journal.csv";
  const parts = String(path).split(/[/\\]/);
  return parts[parts.length - 1] || "journal.csv";
}

function supportsFsAccess() {
  if (isNativeDesktop()) return false;
  return typeof window.showOpenFilePicker === "function"
    && typeof window.showSaveFilePicker === "function";
}

function rememberLastDbPreference() {
  try {
    localStorage.setItem(LS_LAST_DB, JSON.stringify({
      name: meta.name,
      mode: meta.mode,
      nativePath: meta.nativePath || nativePath || null,
      updatedAt: Date.now(),
    }));
  } catch {
    /* ignore */
  }
}

export function getLastDbPreference() {
  try {
    const raw = localStorage.getItem(LS_LAST_DB);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_HANDLES)) d.createObjectStore(STORE_HANDLES);
      if (!d.objectStoreNames.contains(STORE_DATA)) d.createObjectStore(STORE_DATA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, key, value) {
  const idb = await idbOpen();
  await new Promise((resolve, reject) => {
    const tx = idb.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  idb.close();
}

async function idbGet(store, key) {
  const idb = await idbOpen();
  const value = await new Promise((resolve, reject) => {
    const tx = idb.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  idb.close();
  return value;
}

async function idbDelete(store, key) {
  const idb = await idbOpen();
  await new Promise((resolve, reject) => {
    const tx = idb.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  idb.close();
}

async function ensurePermission(handle, mode = "readwrite") {
  if (!handle?.queryPermission) return false;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseCsv(text) {
  const src = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

function normalizeTrade(raw) {
  const num = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const text = (v) => {
    if (v === null || v === undefined) return "";
    return String(v);
  };
  const idNum = Number(raw.id);
  return {
    id: Number.isFinite(idNum) && idNum > 0 ? Math.trunc(idNum) : null,
    entry_date: text(raw.entry_date),
    pair: text(raw.pair),
    direction: text(raw.direction),
    entry_price: num(raw.entry_price),
    stop_loss: num(raw.stop_loss),
    take_profit: num(raw.take_profit),
    strategy: text(raw.strategy) || null,
    setup_idea: text(raw.setup_idea) || null,
    quality: text(raw.quality) || "B",
    exit_reason: text(raw.exit_reason) || null,
    exit_date: text(raw.exit_date),
    exit_price: num(raw.exit_price),
    notes: text(raw.notes) || null,
    archived: Number(raw.archived) ? 1 : 0,
    created_at: text(raw.created_at) || null,
  };
}

function tradesToCsv(list) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const t of list) {
    lines.push(CSV_COLUMNS.map((c) => {
      let v = t[c];
      if (v === null || v === undefined) v = "";
      return csvEscape(v);
    }).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function openFromCsvText(text) {
  const rows = parseCsv(text);
  if (!rows.length) {
    trades = [];
    nextId = 1;
    return;
  }
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  const required = ["pair", "direction", "entry_price", "stop_loss", "take_profit"];
  const missing = required.filter((k) => !(k in idx));
  if (missing.length) {
    throw new Error(`CSV journal missing columns: ${missing.join(", ")}`);
  }

  const out = [];
  let maxId = 0;
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const raw = {};
    for (const col of CSV_COLUMNS) {
      raw[col] = idx[col] !== undefined ? row[idx[col]] : "";
    }
    const t = normalizeTrade(raw);
    if (!t.pair || !t.direction || t.entry_price === null || t.stop_loss === null || t.take_profit === null) {
      continue;
    }
    if (!t.id) t.id = ++maxId;
    maxId = Math.max(maxId, t.id);
    out.push(t);
  }
  trades = out;
  nextId = maxId + 1;
}

function createEmptyJournal() {
  trades = [];
  nextId = 1;
}

function currentCsvText() {
  return tradesToCsv(trades || []);
}

async function saveIdbSnapshot() {
  if (!trades) return;
  await idbPut(STORE_DATA, TEXT_KEY, currentCsvText());
  await idbPut(STORE_DATA, META_KEY, { ...meta });
  rememberLastDbPreference();
}

async function writeTextToHandle(handle, text) {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

export async function initDbModule() {
  /* no WASM / SQL init needed */
}

export function hasDb() {
  return Array.isArray(trades);
}

export function getDbName() {
  return meta.name || fileHandle?.name || (nativePath ? fileNameFromPath(nativePath) : null);
}

export function getNativePath() {
  return nativePath || meta.nativePath || null;
}

export function getStorageMode() {
  return meta.mode;
}

export function isFsSupported() {
  return isNativeDesktop() || supportsFsAccess();
}

export async function loadBundledDefaultJournal() {
  await waitForNativeApi();

  if (isNativeDesktop() && typeof window.pywebview.api.journal_path === "function") {
    const path = await window.pywebview.api.journal_path(BUNDLED_JOURNAL_FILE);
    const exists = await window.pywebview.api.file_exists(path);
    if (exists) {
      const b64 = await window.pywebview.api.read_file(path);
      if (b64) {
        openFromCsvText(base64ToText(b64));
        fileHandle = null;
        nativePath = path;
        meta = { name: BUNDLED_JOURNAL_FILE, mode: "file", nativePath: path };
        await idbDelete(STORE_HANDLES, HANDLE_KEY);
        await saveIdbSnapshot();
        return { name: meta.name, mode: "file", tradeCount: listTrades().length, bundled: true };
      }
    }
  }

  const res = await fetch(`./${BUNDLED_JOURNAL_URL}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Default journal not found (${BUNDLED_JOURNAL_URL}).`);
  }
  openFromCsvText(await res.text());
  fileHandle = null;
  nativePath = null;
  meta = { name: BUNDLED_JOURNAL_FILE, mode: "idb" };
  await idbDelete(STORE_HANDLES, HANDLE_KEY);
  await saveIdbSnapshot();
  return { name: meta.name, mode: "idb", tradeCount: listTrades().length, bundled: true };
}

export async function tryRestoreLastDb() {
  await waitForNativeApi();

  let needsFileReauth = false;
  const savedMetaEarly = await idbGet(STORE_DATA, META_KEY);
  const prefEarly = getLastDbPreference();
  const pathHint = savedMetaEarly?.nativePath || prefEarly?.nativePath || null;
  if (pathHint && isNativeDesktop()) {
    try {
      const exists = await window.pywebview.api.file_exists(pathHint);
      if (exists) {
        const b64 = await window.pywebview.api.read_file(pathHint);
        if (b64) {
          openFromCsvText(base64ToText(b64));
          nativePath = pathHint;
          fileHandle = null;
          meta = {
            name: fileNameFromPath(pathHint),
            mode: "file",
            nativePath: pathHint,
          };
          await saveIdbSnapshot();
          return { ok: true, name: meta.name, mode: "file", default: true };
        }
      }
    } catch {
      /* fall through */
    }
  }

  if (supportsFsAccess()) {
    const handle = await idbGet(STORE_HANDLES, HANDLE_KEY);
    if (handle) {
      const allowed = await ensurePermission(handle, "readwrite");
      if (allowed) {
        try {
          const file = await handle.getFile();
          openFromCsvText(await file.text());
          fileHandle = handle;
          nativePath = null;
          meta = { name: handle.name, mode: "file" };
          await saveIdbSnapshot();
          return { ok: true, name: handle.name, mode: "file", default: true };
        } catch {
          /* fall through */
        }
      } else {
        needsFileReauth = true;
      }
    }
  }

  const text = await idbGet(STORE_DATA, TEXT_KEY);
  const savedMeta = await idbGet(STORE_DATA, META_KEY);
  const pref = getLastDbPreference();
  if (typeof text === "string" && text.length) {
    openFromCsvText(text);
    meta = savedMeta || {
      name: pref?.name || BUNDLED_JOURNAL_FILE,
      mode: "idb",
    };
    fileHandle = null;
    nativePath = meta.nativePath || null;
    rememberLastDbPreference();
    return {
      ok: true,
      name: meta.name,
      mode: meta.mode || "idb",
      default: true,
      needsFileReauth,
    };
  }

  try {
    const bundled = await loadBundledDefaultJournal();
    return {
      ok: true,
      name: bundled.name,
      mode: bundled.mode || "idb",
      default: true,
      bundled: true,
      tradeCount: bundled.tradeCount,
    };
  } catch (err) {
    return { ok: false, reason: "none", preference: pref, error: err };
  }
}

export async function newDatabase({ suggestedName = "My Trading Journal.csv" } = {}) {
  await waitForNativeApi();

  let fileName = (suggestedName || "My Trading Journal.csv").trim();
  if (!fileName) fileName = "My Trading Journal.csv";
  fileName = fileName.split(/[/\\]/).pop() || "My Trading Journal.csv";
  if (!/\.csv$/i.test(fileName)) {
    fileName = fileName.replace(/\.(sqlite|db|sqlite3)$/i, "");
    fileName = `${fileName}.csv`;
  }

  if (isNativeDesktop() && typeof window.pywebview.api.create_journal === "function") {
    const path = await window.pywebview.api.create_journal(fileName);
    if (!path) throw new Error("Could not create journal path.");
    const exists = await window.pywebview.api.file_exists(path);
    if (exists) {
      const overwrite = window.confirm(
        `“${fileNameFromPath(path)}” already exists in the journals folder.\n\nOverwrite it with a blank journal?`,
      );
      if (!overwrite) {
        const err = new Error("Save cancelled");
        err.name = "AbortError";
        throw err;
      }
    }
    createEmptyJournal();
    fileHandle = null;
    nativePath = path;
    meta = { name: fileNameFromPath(path), mode: "file", nativePath: path };
    await window.pywebview.api.write_file(path, textToBase64(currentCsvText()));
    await idbDelete(STORE_HANDLES, HANDLE_KEY);
    await saveIdbSnapshot();
    return { name: meta.name, mode: "file", path };
  }

  createEmptyJournal();
  fileHandle = null;
  nativePath = null;
  meta = { name: fileName, mode: "idb" };
  await idbDelete(STORE_HANDLES, HANDLE_KEY);
  await saveIdbSnapshot();
  exportDownload(fileName);
  return { name: fileName, mode: "idb", downloaded: true };
}

export async function openDatabaseWithFs() {
  await waitForNativeApi();

  if (isNativeDesktop() && typeof window.pywebview.api.link_journal === "function") {
    let result;
    try {
      result = await window.pywebview.api.link_journal();
    } catch (err) {
      throw new Error(err?.message || String(err) || "Could not link journal.");
    }
    if (!result || !result.path) {
      const err = new Error("Open cancelled");
      err.name = "AbortError";
      throw err;
    }
    const b64 = await window.pywebview.api.read_file(result.path);
    if (!b64) throw new Error("Could not read the selected journal file.");
    openFromCsvText(base64ToText(b64));
    fileHandle = null;
    nativePath = result.path;
    meta = { name: result.name || fileNameFromPath(result.path), mode: "file", nativePath: result.path };
    await idbDelete(STORE_HANDLES, HANDLE_KEY);
    await saveIdbSnapshot();
    return {
      name: meta.name,
      mode: "file",
      tradeCount: result.tradeCount ?? result.trade_count ?? listTrades().length,
      source: result.source || result.excel_name || null,
      imported: !!result.imported,
    };
  }

  if (isNativeDesktop() && typeof window.pywebview.api.import_excel_journal === "function") {
    let result;
    try {
      result = await window.pywebview.api.import_excel_journal();
    } catch (err) {
      throw new Error(err?.message || String(err) || "Excel import failed.");
    }
    if (!result || !result.path) {
      const err = new Error("Open cancelled");
      err.name = "AbortError";
      throw err;
    }
    const b64 = await window.pywebview.api.read_file(result.path);
    if (!b64) throw new Error("Could not read the imported journal file.");
    openFromCsvText(base64ToText(b64));
    fileHandle = null;
    nativePath = result.path;
    meta = { name: result.name || fileNameFromPath(result.path), mode: "file", nativePath: result.path };
    await idbDelete(STORE_HANDLES, HANDLE_KEY);
    await saveIdbSnapshot();
    return {
      name: meta.name,
      mode: "file",
      tradeCount: result.tradeCount ?? result.trade_count ?? listTrades().length,
      source: result.source || result.excel_name || null,
      imported: true,
    };
  }

  if (isNativeDesktop()) {
    const path = await window.pywebview.api.open_file();
    if (!path) {
      const err = new Error("Open cancelled");
      err.name = "AbortError";
      throw err;
    }
    const b64 = await window.pywebview.api.read_file(path);
    if (!b64) throw new Error("Could not read the selected journal file.");
    openFromCsvText(base64ToText(b64));
    fileHandle = null;
    nativePath = path;
    meta = { name: fileNameFromPath(path), mode: "file", nativePath: path };
    await idbDelete(STORE_HANDLES, HANDLE_KEY);
    await saveIdbSnapshot();
    return { name: meta.name, mode: "file" };
  }

  if (!supportsFsAccess()) {
    throw new Error("USE_FILE_INPUT");
  }
  const [handle] = await window.showOpenFilePicker({
    multiple: false,
    types: [{
      description: "Trading journal (CSV)",
      accept: { "text/csv": [".csv"], "text/plain": [".csv"] },
    }],
  });
  const allowed = await ensurePermission(handle, "readwrite");
  if (!allowed) throw new Error("Permission denied to open journal file.");
  const file = await handle.getFile();
  openFromCsvText(await file.text());
  fileHandle = handle;
  nativePath = null;
  meta = { name: handle.name, mode: "file" };
  await idbPut(STORE_HANDLES, HANDLE_KEY, handle);
  await saveIdbSnapshot();
  return { name: handle.name, mode: "file" };
}

export async function importFromFile(file) {
  if (!file) throw new Error("No file selected.");
  openFromCsvText(await file.text());
  fileHandle = null;
  nativePath = null;
  meta = { name: file.name || "imported.csv", mode: "idb" };
  await idbDelete(STORE_HANDLES, HANDLE_KEY);
  await saveIdbSnapshot();
  return { name: meta.name, mode: "idb" };
}

export function exportDownload(filename) {
  if (!trades) throw new Error("No journal loaded.");
  const blob = new Blob([currentCsvText()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || meta.name || "cts-trading-journal.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return a.download;
}

export async function persist() {
  if (!trades) throw new Error("No journal loaded.");
  await saveIdbSnapshot();
  if (nativePath && isNativeDesktop()) {
    try {
      await window.pywebview.api.write_file(nativePath, textToBase64(currentCsvText()));
    } catch {
      /* IndexedDB still saved */
    }
    return;
  }
  if (fileHandle && typeof fileHandle.createWritable === "function") {
    try {
      await writeTextToHandle(fileHandle, currentCsvText());
    } catch {
      /* IndexedDB still saved */
    }
  }
}

export function listTrades() {
  if (!trades) return [];
  return [...trades]
    .map((t) => ({ ...t, archived: Number(t.archived) ? 1 : 0 }))
    .sort((a, b) => {
      const da = a.entry_date || "";
      const db = b.entry_date || "";
      if (da !== db) return da < db ? -1 : 1;
      return Number(a.id) - Number(b.id);
    });
}

export async function insertTrade(trade) {
  if (!trades) throw new Error("Open or create a journal first.");
  const id = nextId++;
  trades.push(normalizeTrade({
    id,
    entry_date: trade.entry_date || "",
    pair: trade.pair,
    direction: trade.direction,
    entry_price: trade.entry_price,
    stop_loss: trade.stop_loss,
    take_profit: trade.take_profit,
    strategy: trade.strategy || "",
    setup_idea: trade.setup_idea || "",
    quality: trade.quality,
    notes: trade.notes || "",
    archived: 0,
    created_at: new Date().toISOString(),
  }));
  await persist();
  return id;
}

export async function updateTrade(id, fields) {
  if (!trades) throw new Error("No journal loaded.");
  const allowed = [
    "exit_reason", "exit_date", "exit_price", "notes",
    "pair", "strategy", "setup_idea", "quality", "entry_date",
    "archived",
  ];
  const row = trades.find((t) => Number(t.id) === Number(id));
  if (!row) return;
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      let v = fields[key];
      if ((key === "exit_date" || key === "entry_date") && (v === null || v === undefined)) v = "";
      if (key === "archived") v = Number(v) ? 1 : 0;
      if (key === "exit_price" && (v === null || v === undefined || v === "")) v = null;
      row[key] = v;
    }
  }
  await persist();
}

export async function deleteTrade(id) {
  if (!trades) throw new Error("No journal loaded.");
  trades = trades.filter((t) => Number(t.id) !== Number(id));
  await persist();
}
