/**
 * CSV journal persistence for the browser app.
 *
 * Trade data lives only in a user-picked local CSV file.
 * IndexedDB stores sticky File System Access handles (folder + file mapping)
 * so the same journal reopens until the user redirects manually.
 *
 * Requires Chromium (Chrome / Edge) with File System Access API.
 */

const IDB_NAME = "cts-trader-fs-map";
const IDB_VERSION = 1;
const STORE_HANDLES = "handles";
const FILE_KEY = "journalFile";
const DIR_KEY = "journalDir";
const META_KEY = "journalMeta";

/** @type {Array<Record<string, any>>|null} */
let trades = null;
let nextId = 1;

/** @type {FileSystemFileHandle|null} */
let fileHandle = null;
/** @type {FileSystemDirectoryHandle|null} */
let dirHandle = null;

/** @type {{ name: string|null, dirName: string|null, mode: 'file' }} */
let meta = { name: null, dirName: null, mode: "file" };

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

function supportsFsAccess() {
  return typeof window.showOpenFilePicker === "function"
    && typeof window.showSaveFilePicker === "function"
    && typeof window.showDirectoryPicker === "function";
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_HANDLES)) {
        d.createObjectStore(STORE_HANDLES);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const idb = await idbOpen();
  await new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_HANDLES, "readwrite");
    tx.objectStore(STORE_HANDLES).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  idb.close();
}

async function idbGet(key) {
  const idb = await idbOpen();
  const value = await new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_HANDLES, "readonly");
    const req = tx.objectStore(STORE_HANDLES).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  idb.close();
  return value;
}

async function idbDelete(key) {
  const idb = await idbOpen();
  await new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_HANDLES, "readwrite");
    tx.objectStore(STORE_HANDLES).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  idb.close();
}

async function ensurePermission(handle, mode = "readwrite") {
  if (!handle?.queryPermission) return false;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if (handle.requestPermission && (await handle.requestPermission(opts)) === "granted") {
    return true;
  }
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

async function writeTextToHandle(handle, text) {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function persistMapping() {
  if (fileHandle) await idbPut(FILE_KEY, fileHandle);
  else await idbDelete(FILE_KEY);
  if (dirHandle) await idbPut(DIR_KEY, dirHandle);
  else await idbDelete(DIR_KEY);
  await idbPut(META_KEY, {
    name: meta.name,
    dirName: meta.dirName,
    mode: "file",
    updatedAt: Date.now(),
  });
}

function requireFs() {
  if (!supportsFsAccess()) {
    throw new Error(
      "This browser cannot map a local folder. Use Chrome or Edge, and open the app over http://localhost (not a raw file:// page).",
    );
  }
}

function normalizeCsvName(suggestedName) {
  let fileName = (suggestedName || "My Trading Journal.csv").trim();
  if (!fileName) fileName = "My Trading Journal.csv";
  fileName = fileName.split(/[/\\]/).pop() || "My Trading Journal.csv";
  if (!/\.csv$/i.test(fileName)) {
    fileName = fileName.replace(/\.(xlsx|xls|sqlite|db|sqlite3)$/i, "");
    fileName = `${fileName}.csv`;
  }
  return fileName;
}

async function pickDirectory() {
  requireFs();
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  const allowed = await ensurePermission(handle, "readwrite");
  if (!allowed) throw new Error("Permission denied for the journal folder.");
  return handle;
}

async function pickCsvFile() {
  requireFs();
  const [handle] = await window.showOpenFilePicker({
    multiple: false,
    types: [{
      description: "Trading journal (CSV)",
      accept: { "text/csv": [".csv"], "text/plain": [".csv"] },
    }],
  });
  const allowed = await ensurePermission(handle, "readwrite");
  if (!allowed) throw new Error("Permission denied for the journal file.");
  return handle;
}

async function bindHandles(nextFile, nextDir) {
  fileHandle = nextFile;
  dirHandle = nextDir || null;
  meta = {
    name: nextFile?.name || null,
    dirName: nextDir?.name || null,
    mode: "file",
  };
  await persistMapping();
}

export async function initDbModule() {
  /* no WASM / SQL init needed */
}

export function hasDb() {
  return Array.isArray(trades);
}

export function getDbName() {
  return meta.name || fileHandle?.name || null;
}

export function getNativePath() {
  if (!meta.name) return null;
  if (meta.dirName) return `${meta.dirName}/${meta.name}`;
  return meta.name;
}

export function getStorageMode() {
  return fileHandle ? "file" : (trades ? "memory" : null);
}

export function getDirName() {
  return meta.dirName || dirHandle?.name || null;
}

export function isFsSupported() {
  return supportsFsAccess();
}

export async function clearJournalMapping() {
  fileHandle = null;
  dirHandle = null;
  trades = null;
  nextId = 1;
  meta = { name: null, dirName: null, mode: "file" };
  await idbDelete(FILE_KEY);
  await idbDelete(DIR_KEY);
  await idbDelete(META_KEY);
}

/**
 * Sticky restore: reopen the mapped CSV if permission is still granted.
 * Does not keep trade data in the browser — only the folder/file mapping.
 */
export async function tryRestoreLastDb() {
  if (!supportsFsAccess()) {
    return { ok: false, reason: "unsupported" };
  }

  const savedFile = await idbGet(FILE_KEY);
  const savedDir = await idbGet(DIR_KEY);
  const savedMeta = await idbGet(META_KEY);

  if (!savedFile) {
    return { ok: false, reason: "none", preference: savedMeta || null };
  }

  const allowed = await ensurePermission(savedFile, "readwrite");
  if (!allowed) {
    return {
      ok: false,
      reason: "permission",
      needsFileReauth: true,
      preference: savedMeta || { name: savedFile.name },
    };
  }

  try {
    const file = await savedFile.getFile();
    openFromCsvText(await file.text());
    fileHandle = savedFile;
    dirHandle = null;
    if (savedDir) {
      const dirOk = await ensurePermission(savedDir, "readwrite");
      if (dirOk) dirHandle = savedDir;
    }
    meta = {
      name: savedFile.name,
      dirName: dirHandle?.name || savedMeta?.dirName || null,
      mode: "file",
    };
    await persistMapping();
    return {
      ok: true,
      name: meta.name,
      mode: "file",
      dirName: meta.dirName,
      default: true,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "unreadable",
      error: err,
      preference: savedMeta || { name: savedFile.name },
    };
  }
}

/**
 * Map a local folder + an existing CSV inside the user's workflow.
 * 1) Choose journal folder  2) Choose CSV file
 */
export async function openDatabaseWithFs() {
  requireFs();

  const nextDir = await pickDirectory();
  const nextFile = await pickCsvFile();

  const file = await nextFile.getFile();
  openFromCsvText(await file.text());
  await bindHandles(nextFile, nextDir);

  return {
    name: meta.name,
    mode: "file",
    dirName: meta.dirName,
    tradeCount: listTrades().length,
  };
}

/**
 * Create a new CSV in a mapped folder (picks folder first if needed).
 */
export async function newDatabase({ suggestedName = "My Trading Journal.csv" } = {}) {
  requireFs();

  const fileName = normalizeCsvName(suggestedName);
  let nextDir = dirHandle;
  if (!nextDir) {
    nextDir = await pickDirectory();
  } else {
    const ok = await ensurePermission(nextDir, "readwrite");
    if (!ok) nextDir = await pickDirectory();
  }

  let existing = false;
  try {
    await nextDir.getFileHandle(fileName);
    existing = true;
  } catch {
    existing = false;
  }
  if (existing) {
    const overwrite = window.confirm(
      `“${fileName}” already exists in “${nextDir.name}”.\n\nOverwrite it with a blank journal?`,
    );
    if (!overwrite) {
      const err = new Error("Save cancelled");
      err.name = "AbortError";
      throw err;
    }
  }

  const nextFile = await nextDir.getFileHandle(fileName, { create: true });
  createEmptyJournal();
  await writeTextToHandle(nextFile, currentCsvText());
  await bindHandles(nextFile, nextDir);

  return {
    name: meta.name,
    mode: "file",
    dirName: meta.dirName,
    path: getNativePath(),
  };
}

/**
 * Manual redirect: clear sticky mapping, then link folder + CSV again.
 */
export async function changeJournalLocation() {
  await clearJournalMapping();
  return openDatabaseWithFs();
}

/**
 * One-shot CSV import only works if the user then saves via file picker.
 * Prefer openDatabaseWithFs / newDatabase for normal use.
 */
export async function importFromFile(file) {
  if (!file) throw new Error("No file selected.");
  requireFs();
  openFromCsvText(await file.text());

  const nextDir = await pickDirectory();
  const fileName = normalizeCsvName(file.name || "imported.csv");
  const nextFile = await nextDir.getFileHandle(fileName, { create: true });
  await writeTextToHandle(nextFile, currentCsvText());
  await bindHandles(nextFile, nextDir);

  return {
    name: meta.name,
    mode: "file",
    dirName: meta.dirName,
    tradeCount: listTrades().length,
  };
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
  if (!fileHandle || typeof fileHandle.createWritable !== "function") {
    throw new Error("No local journal file mapped. Link or create a journal first.");
  }
  const allowed = await ensurePermission(fileHandle, "readwrite");
  if (!allowed) {
    throw new Error("Permission lost for the journal file. Use Change Journal Location to re-link.");
  }
  await writeTextToHandle(fileHandle, currentCsvText());
  await persistMapping();
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

/** @deprecated Bundled default is no longer auto-loaded in the browser app. */
export async function loadBundledDefaultJournal() {
  throw new Error("Link a local folder and CSV, or create a new journal.");
}
