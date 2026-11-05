import {
  initDbModule,
  isFsSupported,
  tryRestoreLastDb,
  newDatabase,
  openDatabaseWithFs,
  chooseJournalFolder,
  changeJournalLocation,
  importFromFile,
  hasDb,
  hasMappedDirectory,
  getDbName,
  getNativePath,
  getDirName,
  getStorageMode,
  insertTrade,
} from "./db.js";
import { bindCalculator, readCalculatorForm, compute, validateForLog } from "./calculator.js";
import { bindJournal, renderJournal } from "./journal.js";
import { bindRating } from "./rating.js";
import { bindPerformance, renderPerformance } from "./performance.js";
import { bindTheme } from "./theme.js";
import { APP_VERSION } from "./version.js";

const toastEl = document.getElementById("toast");
const fileInput = document.getElementById("fileImport");
let toastTimer = null;
let lastHighlightId = null;

const MODES = ["calculator", "assess", "journal", "performance"];
const MODE_BTN = {
  calculator: "btnModeCalc",
  assess: "btnModeAssess",
  journal: "btnModeJournal",
  performance: "btnModePerformance",
};
const MODE_VIEW = {
  calculator: "viewCalculator",
  assess: "viewAssess",
  journal: "viewJournal",
  performance: "viewPerformance",
};

function toast(msg, isError = false) {
  toastEl.hidden = false;
  toastEl.textContent = msg;
  toastEl.classList.toggle("error", isError);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3600);
}

function setDbStatus(name, mode) {
  const el = document.getElementById("dbStatus");
  if (!name) {
    el.textContent = "No journal";
    el.title = "Link a local folder + CSV, or create a new journal";
    el.style.color = "var(--danger)";
    return;
  }
  const path = getNativePath();
  const dir = getDirName();
  el.textContent = dir ? `Journal: ${name} · ${dir}/` : `Journal: ${name}`;
  el.title = path
    ? `Mapped local CSV (sticky until you change location):\n${path}`
    : "Mapped local CSV — sticky until you change location";
  el.style.color = "";
  void mode;
}

function refreshStatus() {
  setDbStatus(getDbName(), getStorageMode());
}

function setMode(mode) {
  if (!MODES.includes(mode)) mode = "calculator";

  for (const m of MODES) {
    const view = document.getElementById(MODE_VIEW[m]);
    const btn = document.getElementById(MODE_BTN[m]);
    const active = m === mode;
    if (view) {
      view.hidden = !active;
      view.classList.toggle("is-active", active);
    }
    btn?.classList.toggle("is-active", active);
  }

  const logBar = document.getElementById("logTradeBar");
  if (logBar) logBar.hidden = mode !== "calculator";

  if (mode === "journal") refreshJournal();
  if (mode === "performance") renderPerformance();
}

function applyRatingToCalculator(grade) {
  const sel = document.getElementById("quality");
  if (!sel || !grade) return;
  if (sel.value === grade) {
    // Still refresh risk outputs if quality was already set
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  sel.value = grade;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}

function refreshJournal() {
  if (!hasDb()) {
    document.getElementById("journalBody").innerHTML = "";
    document.getElementById("journalEmpty").hidden = false;
    document.getElementById("journalEmpty").textContent =
      "Create or link a journal to start logging trades.";
    for (const [bodyId, emptyId] of [
      ["parkedBody", "parkedEmpty"],
      ["cancelledBody", "cancelledEmpty"],
    ]) {
      const body = document.getElementById(bodyId);
      const empty = document.getElementById(emptyId);
      if (body) body.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        empty.textContent = "Create or link a journal first.";
      }
    }
    return;
  }
  renderJournal({ highlightId: lastHighlightId });
  if (lastHighlightId) {
    const row =
      document.querySelector(`#journalBody tr[data-id="${lastHighlightId}"]`)
      || document.querySelector(`#parkedBody tr[data-id="${lastHighlightId}"]`)
      || document.querySelector(`#cancelledBody tr[data-id="${lastHighlightId}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => { lastHighlightId = null; }, 1800);
  }
}

async function ensureDbOrPrompt() {
  if (hasDb()) return true;
  toast("Create or link a journal first (Create New Journal / Link Existing Journal).", true);
  return false;
}

async function onLogTrade() {
  if (!(await ensureDbOrPrompt())) return;
  const inputs = readCalculatorForm();
  const computed = compute(inputs);
  const missing = validateForLog(inputs, computed);
  if (missing.length) {
    toast(`Missing: ${missing.join(", ")}`, true);
    return;
  }
  try {
    const id = await insertTrade({
      entry_date: null,
      pair: inputs.pair.toUpperCase(),
      direction: computed.direction,
      entry_price: Number(inputs.entryPrice),
      stop_loss: Number(inputs.stopLoss),
      take_profit: Number(inputs.takeProfit),
      strategy: inputs.strategy || null,
      setup_idea: inputs.setupIdea || null,
      quality: inputs.quality,
    });
    lastHighlightId = id;
    toast(`Logged ${inputs.pair.toUpperCase()} to journal.`);
    setMode("journal");
  } catch (err) {
    toast(err.message || String(err), true);
  }
}

async function boot() {
  await initDbModule();
  bindTheme();

  const verEl = document.getElementById("appVersion");
  if (verEl) {
    verEl.textContent = `v${APP_VERSION}`;
    verEl.title = `Crypto TA Secrets TRADER App v${APP_VERSION}`;
  }

  bindCalculator();
  bindJournal(() => refreshJournal());
  bindRating({
    onGradeChange: applyRatingToCalculator,
    onOpenCalculator: () => setMode("calculator"),
  });
  bindPerformance({
    onOpenTrade: (id) => {
      const pairFilter = document.getElementById("filterPair");
      const timeframe = document.getElementById("filterTimeframe");
      if (pairFilter) pairFilter.value = "";
      if (timeframe) timeframe.value = "all";
      lastHighlightId = id;
      setMode("journal");
    },
  });

  document.getElementById("btnModeCalc").addEventListener("click", () => setMode("calculator"));
  document.getElementById("btnModeAssess").addEventListener("click", () => setMode("assess"));
  document.getElementById("btnModeJournal").addEventListener("click", () => setMode("journal"));
  document.getElementById("btnModePerformance").addEventListener("click", () => setMode("performance"));
  document.getElementById("btnGoAssess")?.addEventListener("click", () => setMode("assess"));
  document.getElementById("btnLogTrade").addEventListener("click", onLogTrade);

  document.getElementById("btnNewDb").addEventListener("click", async () => {
    try {
      if (!isFsSupported()) {
        toast("Use the latest Google Chrome or Brave, and open the https link.", true);
        return;
      }
      if (!hasMappedDirectory()) {
        await chooseJournalFolder();
      }
      if (hasDb() && !confirm("Create a new journal CSV in your mapped folder? The current file stays on disk; this app will switch to the new one.")) {
        return;
      }

      const typed = window.prompt(
        "New journal file name (saved in your chosen local folder):",
        "My Trading Journal",
      );
      if (typed === null) return;
      const suggestedName = typed.trim() || "My Trading Journal";

      const result = await newDatabase({ suggestedName });
      refreshStatus();
      refreshJournal();
      toast(`Created “${result.name}” in folder “${result.dirName || "local"}” — mapping saved`);
    } catch (err) {
      if (err?.name === "AbortError") return;
      toast(err.message || String(err), true);
    }
  });

  document.getElementById("btnOpenDb").addEventListener("click", async () => {
    try {
      if (!isFsSupported()) {
        toast("Use the latest Google Chrome or Brave, and open the https link.", true);
        return;
      }
      const result = await openDatabaseWithFs();
      refreshStatus();
      refreshJournal();
      toast(
        `Mapped “${result.name}”`
        + (result.dirName ? ` in “${result.dirName}/”` : "")
        + (result.tradeCount != null ? ` (${result.tradeCount} trades)` : "")
        + " — sticky until you change location",
      );
    } catch (err) {
      if (err?.name === "AbortError") return;
      toast(err.message || String(err), true);
    }
  });

  document.getElementById("btnChangeDb")?.addEventListener("click", async () => {
    try {
      if (!isFsSupported()) {
        toast("Use the latest Google Chrome or Brave, and open the https link.", true);
        return;
      }
      const result = await changeJournalLocation();
      refreshStatus();
      refreshJournal();
      toast(
        `Redirected to “${result.name}”`
        + (result.dirName ? ` in “${result.dirName}/”` : "")
        + " — new sticky mapping",
      );
    } catch (err) {
      if (err?.name === "AbortError") return;
      toast(err.message || String(err), true);
    }
  });

  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const result = await importFromFile(file);
      refreshStatus();
      refreshJournal();
      toast(`Saved “${result.name}” into “${result.dirName}/” — mapping saved`);
    } catch (err) {
      if (err?.name === "AbortError") return;
      toast(err.message || String(err), true);
    }
  });

  setMode("calculator");

  if (!isFsSupported()) {
    setDbStatus(null);
    toast("Use the latest Google Chrome or Brave. Open https://cryptoknightjk.github.io/TRADER-App/", true);
    return;
  }

  const restored = await tryRestoreLastDb();
  if (restored.ok) {
    refreshStatus();
    toast(
      `Reopened mapped journal “${restored.name}”`
      + (restored.dirName ? ` (${restored.dirName}/)` : ""),
    );
  } else if (restored.needsFileReauth || restored.reason === "permission") {
    setDbStatus(null);
    const prior = restored.preference?.name ? ` “${restored.preference.name}”` : "";
    toast(`Browser needs permission again for${prior}. Click Link Existing Journal to re-map.`, true);
  } else {
    setDbStatus(null);
    toast("No journal mapped yet — Link Existing Journal (folder + CSV) or Create New Journal.");
  }
}

boot().catch((err) => {
  console.error(err);
  toast(err.message || String(err), true);
});
