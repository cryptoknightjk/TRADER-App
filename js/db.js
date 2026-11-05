/**
 * CSV journal persistence for the browser app.
 *
 * Trade data lives only in a user-picked local CSV file.
 * IndexedDB stores sticky File System Access handles (folder + file mapping)
 * so the same journal reopens until the user redirects manually.
 *
 * Chrome and Brave (File System Access API). One folder picker per click —
 * a second native dialog, or a prompt before the picker, is blocked in Brave.
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

/** Granted check only. requestPermission outside a click throws in Brave. */
async function hasWriteAccess(handle) {
  if (!handle?.queryPermission) return true;
  try {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

function abortError(message = "Open cancelled") {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
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
  if (!window.isSecureContext) {
    throw new Error("Open the app from the https link (Chrome or Brave). A downloaded file:// page cannot map a local folder.");
  }
  if (!supportsFsAccess()) {
    throw new Error("Use the latest Google Chrome or Brave. This page needs the local folder picker those browsers provide.");
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

async function listCsvNames(directory) {
  const names = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === "file" && /\.csv$/i.test(name)) names.push(name);
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return names;
}

/** Must be the first await in a click handler (Chrome and Brave). */
async function pickDirectory() {
  requireFs();
  return window.showDirectoryPicker({
    id: "cts-trader-journal",
    mode: "readwrite",
  });
}

function chooseCsvName(dirName, names) {
  if (names.length === 1) return names[0];
  const typed = window.prompt(
    `CSV files in “${dirName}”:\n\n${names.join("\n")}\n\nType the file name to use:`,
    names[0],
  );
  if (typed === null) throw abortError();
  const wanted = typed.trim().toLowerCase();
  const match = names.find((name) => name.toLowerCase() === wanted)
    || names.find((name) => name.toLowerCase() === `${wanted}.csv`);
  if (!match) throw new Error(`“${typed.trim()}” is not a CSV in that folder.`);
  return match;
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
  return window.isSecureContext && supportsFsAccess();
}

export function hasMappedDirectory() {
  return !!dirHandle;
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

  if (!(await hasWriteAccess(savedFile))) {
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
    if (savedDir && await hasWriteAccess(savedDir)) dirHandle = savedDir;
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
 * Map a local folder. The CSV is chosen inside that folder (no second file dialog).
 * Call this directly from a click so Chrome and Brave still have the user gesture.
 */
export async function openDatabaseWithFs() {
  const nextDir = await pickDirectory();
  const names = await listCsvNames(nextDir);
  if (!names.length) {
    fileHandle = null;
    trades = null;
    nextId = 1;
    dirHandle = nextDir;
    meta = { name: null, dirName: nextDir.name, mode: "file" };
    await persistMapping();
    throw new Error(`No CSV in “${nextDir.name}”. Click Create New Journal to add one in that folder.`);
  }
  const fileName = chooseCsvName(nextDir.name, names);
  const nextFile = await nextDir.getFileHandle(fileName);
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

/** Folder picker only. Must run before any confirm/prompt (Brave). */
export async function chooseJournalFolder() {
  const nextDir = await pickDirectory();
  dirHandle = nextDir;
  meta = {
    name: fileHandle?.name || null,
    dirName: nextDir.name,
    mode: "file",
  };
  await persistMapping();
  return nextDir.name;
}

/**
 * Create a new CSV in a mapped folder (picks folder first if needed).
 */
export async function newDatabase({ suggestedName = "My Trading Journal.csv" } = {}) {
  requireFs();

  const fileName = normalizeCsvName(suggestedName);
  const nextDir = dirHandle;
  if (!nextDir) {
    throw new Error("Choose a folder first.");
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
 * Manual redirect. Picker runs first so a cancel leaves the old mapping in place.
 */
export async function changeJournalLocation() {
  return openDatabaseWithFs();
}

/**
 * One-shot CSV import only works if the user then saves via file picker.
 * Prefer openDatabaseWithFs / newDatabase for normal use.
 */
export async function importFromFile(file) {
  if (!file) throw new Error("No file selected.");
  if (!dirHandle) {
    throw new Error("Link a folder first (Link Existing Journal), then import the CSV into it.");
  }
  openFromCsvText(await file.text());
  const fileName = normalizeCsvName(file.name || "imported.csv");
  const nextFile = await dirHandle.getFileHandle(fileName, { create: true });
  await writeTextToHandle(nextFile, currentCsvText());
  await bindHandles(nextFile, dirHandle);

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
  try {
    await writeTextToHandle(fileHandle, currentCsvText());
  } catch (err) {
    if (err?.name === "NotAllowedError") {
      throw new Error("Permission lost for the journal file. Click Change Location and pick the folder again.");
    }
    throw err;
  }
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
