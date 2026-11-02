import {
  initDbModule,
  isFsSupported,
  tryRestoreLastDb,
  newDatabase,
  openDatabaseWithFs,
  importFromFile,
  hasDb,
  getDbName,
  getNativePath,
  getStorageMode,
  insertTrade,
} from "./db.js?v=plan3";
import { bindCalculator, readCalculatorForm, compute, validateForLog } from "./calculator.js?v=plan3";
import { bindJournal, renderJournal } from "./journal.js?v=plan3";
import { bindRating } from "./rating.js?v=plan3";
import { bindPerformance, renderPerformance } from "./performance.js?v=plan3";
import { bindTheme } from "./theme.js?v=plan3";
import { APP_VERSION } from "./version.js?v=plan3";

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
    el.title = "";
    el.style.color = "var(--danger)";
    return;
  }
  const path = getNativePath();
  const tag = mode === "file" ? "csv" : "browser";
  el.textContent = `Journal: ${name} (${tag})`;
  el.title = path
    ? `Pointing to CSV:\n${path}`
    : "Last opened journal — restored automatically on launch";
  el.style.color = "";
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

function triggerImport() {
  fileInput.value = "";
  fileInput.click();
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
      if (hasDb() && !confirm("Create a new journal? Your current journal stays on disk; this app will switch to the new one.")) {
        return;
      }

      const typed = window.prompt(
        "Journal name (saved in the app’s journals folder):",
        "My Trading Journal",
      );
      if (typed === null) return;
      const suggestedName = typed.trim() || "My Trading Journal";

      const result = await newDatabase({ suggestedName });
      refreshStatus();
      refreshJournal();
      toast(`Created journal “${result.name}” in journals/ — set as default`);
    } catch (err) {
      if (err?.name === "AbortError") return;
      toast(err.message || String(err), true);
    }
  });

  document.getElementById("btnOpenDb").addEventListener("click", async () => {
    try {
      if (isFsSupported()) {
        try {
          const result = await openDatabaseWithFs();
          refreshStatus();
          refreshJournal();
          if (result.imported) {
            toast(
              `Imported “${result.source || result.name}” → journals/${result.name}`
              + (result.tradeCount != null ? ` (${result.tradeCount} trades)` : "")
              + " — set as default",
            );
          } else {
            const path = getNativePath();
            toast(
              path
                ? `Pointing to CSV “${result.name}”\n${path}`
                : `Linked journal “${result.name}” — set as default`,
            );
          }
          return;
        } catch (err) {
          if (err?.name === "AbortError") return;
          if (err?.message !== "USE_FILE_INPUT") {
            toast(err.message || String(err), true);
            return;
          }
        }
      }
      triggerImport();
    } catch (err) {
      if (err?.name === "AbortError") return;
      toast(err.message || String(err), true);
    }
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const result = await importFromFile(file);
      refreshStatus();
      refreshJournal();
      toast(`Linked journal “${result.name}” — set as default`);
    } catch (err) {
      toast(err.message || String(err), true);
    }
  });

  setMode("calculator");

  const restored = await tryRestoreLastDb();
  if (restored.ok) {
    refreshStatus();
    if (restored.bundled) {
      toast(`Linked default journal “${restored.name}” (${restored.tradeCount || 0} trades).`);
    } else if (restored.needsFileReauth) {
      toast(`Using last journal “${restored.name}”. Click Link Existing Journal once to re-link the file.`);
    } else {
      toast(`Using last journal: ${restored.name}`);
    }
  } else {
    setDbStatus(null);
    toast("No journal yet — click Create New Journal or Link Existing Journal.");
  }
}

boot().catch((err) => {
  console.error(err);
  toast(err.message || String(err), true);
});
