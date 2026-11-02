import { deriveTradeMetrics } from "./calculator.js";
import { listTrades, updateTrade, deleteTrade } from "./db.js";

const EXIT_REASONS = ["", "TP", "SL", "Trailing stop", "Manual Exit"];

const QUALITY_RANK = { "A+": 4, A: 3, B: 2, C: 1 };
const POS_RANK = { Closed: 3, Open: 2, "N.A.": 1, "Not Opened": 0 };
const WL_RANK = { W: 3, BE: 2, L: 1 };

/** @type {{ key: string, dir: 'asc' | 'desc' }} */
let sortState = { key: "entry_date", dir: "asc" };

const SORT_COLUMNS = [
  { key: "id", label: "#" },
  { key: "position", label: "Position" },
  { key: "entry_date", label: "Entry Date", colClass: "col-date", fixedWidth: 150 },
  { key: "pair", label: "Pair" },
  { key: "direction", label: "Direction" },
  { key: "entry_price", label: "Entry" },
  { key: "stop_loss", label: "SL" },
  { key: "take_profit", label: "TP" },
  { key: "rr", label: "R:R" },
  { key: "strategy", label: "Strategy" },
  { key: "setup_idea", label: "Setup Idea", colClass: "col-setup-idea", fixedWidth: 300 },
  { key: "quality", label: "Quality" },
  { key: "riskAdj", label: "Risk %" },
  { key: "leverage", label: "Lev" },
  { key: "sizePct", label: "Size %" },
  { key: "marginPct", label: "Margin %" },
  { key: "exit_reason", label: "Exit Reason" },
  { key: "exit_date", label: "Exit Date", colClass: "col-date", fixedWidth: 150 },
  { key: "exit_price", label: "Exit Price", colClass: "col-exit-price", fixedWidth: 150 },
  { key: "wl", label: "W/L" },
  { key: "priceChange", label: "Price Δ" },
  { key: "roe", label: "ROE" },
  { key: "acctPct", label: "Trade Win/Loss", headerHtml: "Trade<br>Win/Loss", colClass: "col-header-stack col-acct-pct", fixedWidth: 88 },
  { key: "cumul", label: "Cumulative Account Change %", headerHtml: "Cumulative<br>Account Change %", colClass: "col-header-stack col-cumul-pct", fixedWidth: 88 },
  { key: "notes", label: "Notes" },
];

/** Similar columns share one width — equalized to the widest in the group. */
const WIDTH_EQUALIZE_GROUPS = [
  ["entry_date", "exit_date", "exit_price"],
  ["entry_price", "stop_loss", "take_profit"],
  ["riskAdj", "sizePct", "marginPct"],
  ["priceChange", "roe", "acctPct", "cumul"],
  ["quality", "leverage", "wl", "rr"],
  ["pair", "strategy"],
];

function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  return `${(n * 100).toFixed(2)}%`;
}

/** Format a price/number without padding trailing zeros (0.21 not 0.210000). */
function fmtFixed(n, maxDigits = 8) {
  if (n === null || n === undefined || n === "" || Number.isNaN(Number(n))) return "";
  const s = Number(n).toFixed(maxDigits);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

function normalizeDateField(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (!s) return "";
  const upper = s.toUpperCase();
  if (
    upper === "N.A."
    || upper === "N/A"
    || upper === "NA"
    || upper === "NIL"
    || upper === "NONE"
    || upper === "-"
    || upper === "—"
    || upper === "."
  ) {
    return "";
  }
  // Only real calendar dates count (HTML date inputs use YYYY-MM-DD)
  const iso = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return iso;
}

function hasEntryDate(trade) {
  return !!normalizeDateField(trade.entry_date);
}

function hasExitDate(trade) {
  return !!normalizeDateField(trade.exit_date);
}

function isArchived(trade) {
  return Number(trade.archived) === 1;
}

/** Active journal: filled (has entry) and not cancelled. */
function isActiveTrade(trade) {
  return hasEntryDate(trade) && !isArchived(trade);
}

/** Not triggered: waiting for fill (no entry date), not cancelled. */
function isNotTriggeredTrade(trade) {
  return !hasEntryDate(trade) && !isArchived(trade);
}

/** Cancelled: moved via Archive Trade Idea. */
function isCancelledTrade(trade) {
  return isArchived(trade);
}

/**
 * Position rules (main journal):
 * - Open: entry date present, exit date blank
 * - Closed: entry date AND exit date both present
 * Exit reason / exit price alone do not close a trade.
 */
function positionStatus(trade, { section = "active" } = {}) {
  if (section === "cancelled") {
    return { label: "N.A.", cls: "pos-archived" };
  }
  if (section === "notTriggered") {
    return { label: "Not Opened", cls: "pos-not-opened" };
  }
  if (hasEntryDate(trade) && hasExitDate(trade)) {
    return { label: "Closed", cls: "pos-closed" };
  }
  if (hasEntryDate(trade)) {
    return { label: "Open", cls: "pos-open" };
  }
  return { label: "Not Opened", cls: "pos-not-opened" };
}

function sortValue(row, key) {
  const { t, m, cumul, pos } = row;
  switch (key) {
    case "id": return Number(t.id);
    case "position": return POS_RANK[pos.label] ?? 0;
    case "entry_date": return t.entry_date || "";
    case "pair": return (t.pair || "").toLowerCase();
    case "direction": return (t.direction || "").toUpperCase();
    case "entry_price": return numOrNull(t.entry_price);
    case "stop_loss": return numOrNull(t.stop_loss);
    case "take_profit": return numOrNull(t.take_profit);
    case "rr": return m.rr;
    case "strategy": return (t.strategy || "").toLowerCase();
    case "setup_idea": return (t.setup_idea || "").toLowerCase();
    case "quality": return QUALITY_RANK[t.quality] ?? 0;
    case "riskAdj": return m.riskAdj;
    case "leverage": return m.leverage;
    case "sizePct": return m.sizePct;
    case "marginPct": return m.marginPct;
    case "exit_reason": return (t.exit_reason || "").toLowerCase();
    case "exit_date": return t.exit_date || "";
    case "exit_price": return numOrNull(t.exit_price);
    case "wl": return WL_RANK[m.wl] ?? 0;
    case "priceChange": return m.priceChange;
    case "roe": return m.roe;
    case "acctPct": return m.acctPct;
    case "cumul": return cumul;
    case "notes": return (t.notes || "").toLowerCase();
    default: return null;
  }
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function compareRows(a, b, key, dir) {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  const aEmpty = av === null || av === undefined || av === "";
  const bEmpty = bv === null || bv === undefined || bv === "";
  if (aEmpty && bEmpty) return Number(a.t.id) - Number(b.t.id);
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  let cmp = 0;
  if (typeof av === "number" && typeof bv === "number") {
    cmp = av - bv;
  } else {
    cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
  }
  if (cmp === 0) cmp = Number(a.t.id) - Number(b.t.id);
  return dir === "desc" ? -cmp : cmp;
}

function renderSortHeaders() {
  const tr = document.querySelector("#journalTable thead tr");
  if (!tr) return;
  tr.innerHTML = SORT_COLUMNS.map(({ key, label, colClass, headerHtml }) => {
    const active = sortState.key === key;
    const aria = active
      ? (sortState.dir === "asc" ? "ascending" : "descending")
      : "none";
    const indicator = !active ? "↕" : (sortState.dir === "asc" ? "▲" : "▼");
    const cls = colClass ? ` class="${colClass}"` : "";
    const title = headerHtml || escapeHtml(label);
    return `
      <th${cls}>
        <button type="button" class="sort-btn ${active ? "is-active" : ""}" data-sort="${key}" aria-sort="${aria}" title="${escapeAttr(label)}">
          <span class="sort-label">${title}</span>
          <span class="sort-ind" aria-hidden="true">${indicator}</span>
        </button>
      </th>`;
  }).join("") + "<th></th>";

  // Keep secondary section headers in the same order/labels (non-sortable)
  for (const tableId of ["#parkedTable", "#cancelledTable"]) {
    const secTr = document.querySelector(`${tableId} thead tr`);
    if (secTr) {
      secTr.innerHTML = SORT_COLUMNS.map(({ label, colClass, headerHtml }) => {
        const cls = colClass ? ` class="${colClass}"` : "";
        const title = headerHtml || escapeHtml(label);
        return `<th${cls} title="${escapeAttr(label)}">${title}</th>`;
      }).join("") + "<th></th>";
    }
  }
}

/** Match column widths across main journal, not triggered, and cancelled tables. */
function syncJournalColumnWidths() {
  const tables = ["journalTable", "parkedTable", "cancelledTable"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (tables.length < 2) return;

  for (const table of tables) {
    table.style.tableLayout = "";
    table.style.width = "";
    table.querySelector("colgroup")?.remove();
  }

  const headerSets = tables.map((table) => [...table.querySelectorAll("thead th")]);
  const colCount = headerSets[0]?.length || 0;
  if (!colCount || headerSets.some((hs) => hs.length !== colCount)) return;

  const widths = Array.from({ length: colCount }, (_, i) => {
    const colDef = SORT_COLUMNS[i];
    if (colDef?.fixedWidth) return colDef.fixedWidth;

    let max = 0;
    for (const table of tables) {
      const th = table.querySelectorAll("thead th")[i];
      if (th) max = Math.max(max, th.getBoundingClientRect().width);
      table.querySelectorAll(`tbody tr td:nth-child(${i + 1})`).forEach((c) => {
        max = Math.max(max, c.getBoundingClientRect().width);
      });
    }
    return Math.max(24, Math.ceil(max));
  });

  // Similar columns → same width (use the widest in each group)
  for (const keys of WIDTH_EQUALIZE_GROUPS) {
    const indices = keys
      .map((k) => SORT_COLUMNS.findIndex((c) => c.key === k))
      .filter((i) => i >= 0 && i < widths.length);
    if (indices.length < 2) continue;
    const maxW = Math.max(...indices.map((i) => widths[i]));
    for (const i of indices) widths[i] = maxW;
  }

  const total = widths.reduce((a, b) => a + b, 0);
  for (const table of tables) {
    const colgroup = document.createElement("colgroup");
    colgroup.innerHTML = widths.map((w) => `<col style="width:${w}px">`).join("");
    table.prepend(colgroup);
    table.style.tableLayout = "fixed";
    table.style.width = `${total}px`;
  }
}

function startOfTodayLocal() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseEntryDate(value) {
  if (!value || !String(value).trim()) return null;
  const d = new Date(`${String(value).trim().slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Filter by entry date against the selected time frame. */
function inTimeframe(entryDate, frame) {
  if (!frame || frame === "all") return true;
  const d = parseEntryDate(entryDate);
  if (!d) return false;

  const today = startOfTodayLocal();
  let start = null;

  if (frame === "7d") {
    start = new Date(today);
    start.setDate(start.getDate() - 6);
  } else if (frame === "mtd") {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
  } else if (frame === "ytd") {
    start = new Date(today.getFullYear(), 0, 1);
  } else if (frame === "365d") {
    start = new Date(today);
    start.setDate(start.getDate() - 364);
  } else {
    return true;
  }

  return d >= start && d <= today;
}

function buildRows(trades, { section = "active" } = {}) {
  let cumul = 0;
  return trades.map((t) => {
    const m = deriveTradeMetrics(t);
    if (m.acctPct !== null) cumul += m.acctPct;
    return {
      t,
      m,
      cumul: m.acctPct !== null ? cumul : null,
      pos: positionStatus(t, { section }),
    };
  });
}

function rowActionsHtml({ section = "active" } = {}) {
  if (section === "cancelled") {
    return `
      <td class="row-actions">
        <button type="button" class="btn ghost btn-restore" title="Restore to journal">Restore</button>
        <button type="button" class="btn danger btn-del" title="Delete">✕</button>
      </td>`;
  }
  if (section === "notTriggered") {
    return `
      <td class="row-actions">
        <button type="button" class="btn ghost btn-archive" title="Archive trade idea">Archive Trade Idea</button>
        <button type="button" class="btn danger btn-del" title="Delete">✕</button>
      </td>`;
  }
  return `
    <td class="row-actions">
      <button type="button" class="btn ghost btn-archive" title="Archive trade idea">Archive Trade Idea</button>
      <button type="button" class="btn danger btn-del" title="Delete">✕</button>
    </td>`;
}

function blankClass(value, { highlight = true } = {}) {
  if (!highlight) return "";
  if (value === null || value === undefined) return "input-yellow";
  return String(value).trim() === "" ? "input-yellow" : "";
}

function renderRowHtml({ t, m, cumul: c, pos }, idx, { section = "active", highlightId = null } = {}) {
  const isNew = highlightId && Number(highlightId) === Number(t.id);
  const yellow = section !== "cancelled";
  return `
    <tr data-id="${t.id}" class="${isNew ? "is-new" : ""}">
      <td>${idx + 1}</td>
      <td><span class="pos-badge ${pos.cls}">${pos.label}</span></td>
      <td class="col-date"><input type="date" data-field="entry_date" class="${blankClass(normalizeDateField(t.entry_date), { highlight: yellow })}" value="${normalizeDateField(t.entry_date)}" title="Fill when the limit fills" /></td>
      <td>${escapeHtml(t.pair || "")}</td>
      <td>${directionCell(t.direction)}</td>
      <td>${fmtFixed(t.entry_price, 6)}</td>
      <td>${fmtFixed(t.stop_loss, 6)}</td>
      <td>${fmtFixed(t.take_profit, 6)}</td>
      <td>${m.rr === null ? "" : m.rr.toFixed(3)}</td>
      <td>${escapeHtml(t.strategy || "")}</td>
      <td class="col-setup-idea">${setupIdeaCell(t.setup_idea)}</td>
      <td>${escapeHtml(t.quality || "")}</td>
      <td>${m.riskAdj === null ? "" : m.riskAdj}</td>
      <td>${m.leverage ?? ""}</td>
      <td>${m.sizePct === null ? "" : m.sizePct.toFixed(3)}</td>
      <td>${m.marginPct === null ? "" : m.marginPct.toFixed(3)}</td>
      <td>
        <select data-field="exit_reason" class="${blankClass(t.exit_reason, { highlight: yellow })}">
          ${EXIT_REASONS.map((r) => `<option value="${r}" ${t.exit_reason === r ? "selected" : ""}>${r || "—"}</option>`).join("")}
        </select>
      </td>
      <td class="col-date"><input type="date" data-field="exit_date" class="${blankClass(normalizeDateField(t.exit_date), { highlight: yellow })}" value="${normalizeDateField(t.exit_date)}" /></td>
      <td class="col-exit-price"><input type="number" step="any" data-field="exit_price" class="${blankClass(t.exit_price, { highlight: yellow })}" value="${fmtFixed(t.exit_price)}" /></td>
      <td>${wlCell(m.wl)}</td>
      <td>${fmtPct(m.priceChange)}</td>
      <td>${m.roe === null ? "" : m.roe.toFixed(3)}</td>
      <td class="col-acct-pct">${signedPctCell(m.acctPct)}</td>
      <td class="col-cumul-pct">${signedPctCell(c)}</td>
      <td><input type="text" data-field="notes" value="${escapeAttr(t.notes || "")}" placeholder="Post-trade notes" /></td>
      ${rowActionsHtml({ section })}
    </tr>
  `;
}

export function renderJournal({ highlightId = null, filterPair = "", filterTimeframe = "" } = {}) {
  const body = document.getElementById("journalBody");
  const empty = document.getElementById("journalEmpty");
  const parkedBody = document.getElementById("parkedBody");
  const parkedEmpty = document.getElementById("parkedEmpty");
  const cancelledBody = document.getElementById("cancelledBody");
  const cancelledEmpty = document.getElementById("cancelledEmpty");
  const timeframeSelect = document.getElementById("filterTimeframe");

  let trades = listTrades();

  // Clear junk exit dates (e.g. "N.A.") that look blank in the date picker but keep Position=Closed
  for (const t of trades) {
    const raw = t.exit_date;
    if (raw === null || raw === undefined) continue;
    const s = String(raw).trim();
    if (!s) continue;
    if (normalizeDateField(raw)) continue;
    t.exit_date = "";
    void updateTrade(Number(t.id), { exit_date: "" });
  }

  const pairQ = (filterPair || document.getElementById("filterPair").value || "").trim().toLowerCase();
  const frame = filterTimeframe || timeframeSelect?.value || "all";
  if (timeframeSelect && frame) timeframeSelect.value = frame;

  const matchesFilters = (t) => {
    if (pairQ && !(t.pair || "").toLowerCase().includes(pairQ)) return false;
    // Not-opened / cancelled without entry stay visible unless pair filter excludes them
    if (!hasEntryDate(t)) return true;
    if (!inTimeframe(t.entry_date, frame)) return false;
    return true;
  };

  trades = trades.filter(matchesFilters);

  const activeTrades = trades.filter(isActiveTrade);
  const notTriggeredTrades = trades.filter(isNotTriggeredTrade);
  const cancelledTrades = trades.filter(isCancelledTrade);

  let activeRows = buildRows(activeTrades, { section: "active" });
  activeRows = [...activeRows].sort((a, b) => compareRows(a, b, sortState.key, sortState.dir));

  const parkedRows = buildRows(notTriggeredTrades, { section: "notTriggered" });
  const cancelledRows = buildRows(cancelledTrades, { section: "cancelled" });

  renderSortHeaders();

  empty.hidden = activeRows.length > 0;
  body.innerHTML = activeRows
    .map((row, idx) => renderRowHtml(row, idx, { section: "active", highlightId }))
    .join("");

  if (parkedBody) {
    parkedEmpty.hidden = parkedRows.length > 0;
    parkedBody.innerHTML = parkedRows
      .map((row, idx) => renderRowHtml(row, idx, { section: "notTriggered", highlightId }))
      .join("");
  }

  if (cancelledBody) {
    cancelledEmpty.hidden = cancelledRows.length > 0;
    cancelledBody.innerHTML = cancelledRows
      .map((row, idx) => renderRowHtml(row, idx, { section: "cancelled", highlightId }))
      .join("");
  }

  // Align columns after all tables are in the DOM
  requestAnimationFrame(() => syncJournalColumnWidths());
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll('"', "&quot;");
}

/** Normalize setup idea into an http(s) URL, or null if empty. */
function setupIdeaHref(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return `https:${s}`;
  return `https://${s}`;
}

function setupIdeaCell(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const href = setupIdeaHref(text);
  if (!href) return escapeHtml(text);
  return `<a class="setup-idea-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(text)}">${escapeHtml(text)}</a>`;
}

function directionCell(raw) {
  const d = String(raw || "").trim();
  if (!d) return "";
  const upper = d.toUpperCase();
  const cls = upper === "LONG" ? "dir-long" : upper === "SHORT" ? "dir-short" : "";
  return cls
    ? `<span class="dir-badge ${cls}">${escapeHtml(d)}</span>`
    : escapeHtml(d);
}

function wlCell(wl) {
  if (!wl) return "";
  const u = String(wl).toUpperCase();
  const cls = u === "W" ? "wl-win" : u === "L" ? "wl-loss" : "";
  return cls
    ? `<span class="${cls}">${escapeHtml(wl)}</span>`
    : escapeHtml(wl);
}

function signedPctCell(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  const cls = n > 0 ? "pct-pos" : n < 0 ? "pct-neg" : "";
  const text = fmtPct(n);
  return cls ? `<span class="${cls}">${text}</span>` : text;
}

async function handleFieldChange(el, onChanged) {
  const field = el.getAttribute("data-field");
  if (!field) return;
  const tr = el.closest("tr");
  const id = Number(tr.dataset.id);
  let value = el.value;
  if (field === "exit_price") {
    value = value === "" ? null : Number(value);
  }
  if (field === "exit_reason" && value === "") value = null;
  // Persist cleared dates as "" so CSV/reload stays consistent
  if (field === "exit_date" && value === "") value = "";
  if (field === "entry_date" && value === "") value = "";

  const patch = { [field]: value };

  if (field === "exit_reason" && value === null) {
    patch.exit_date = "";
    patch.exit_price = null;
    const dateInput = tr.querySelector('[data-field="exit_date"]');
    const priceInput = tr.querySelector('[data-field="exit_price"]');
    if (dateInput) {
      dateInput.value = "";
      dateInput.classList.add("input-yellow");
    }
    if (priceInput) priceInput.value = "";
  } else if (field === "exit_reason" && (value === "TP" || value === "SL")) {
    const trade = listTrades().find((t) => Number(t.id) === id);
    if (trade) {
      const autoPrice = value === "TP" ? trade.take_profit : trade.stop_loss;
      if (autoPrice !== null && autoPrice !== undefined && autoPrice !== "") {
        patch.exit_price = Number(autoPrice);
        const priceInput = tr.querySelector('[data-field="exit_price"]');
        if (priceInput) priceInput.value = fmtFixed(patch.exit_price);
      }
    }
  }

  // Filling entry date on a not-opened trade moves it to the main journal
  if (field === "entry_date" && value) {
    const trade = listTrades().find((t) => Number(t.id) === id);
    if (trade && isArchived(trade)) {
      // Keep archived until Restore — still allow editing entry date while parked
    }
  }

  try {
    await updateTrade(id, patch);
    onChanged?.();
  } catch (err) {
    alert(err.message || String(err));
  }
}

async function askConfirm(message, title = "Confirm") {
  try {
    if (window.pywebview?.api && typeof window.pywebview.api.confirm === "function") {
      return !!(await window.pywebview.api.confirm(message, title));
    }
  } catch {
    // fall through to browser confirm
  }
  return window.confirm(message);
}

function bindTableBody(body, onChanged) {
  if (!body || body.dataset.bound === "1") return;
  body.dataset.bound = "1";

  const syncBlankHighlight = (el) => {
    if (!el?.matches?.("[data-field]")) return;
    // Trades cancelled: never use yellow blank highlighting
    if (el.closest("#cancelledBody")) {
      el.classList.remove("input-yellow");
      return;
    }
    const field = el.getAttribute("data-field");
    if (!["entry_date", "exit_reason", "exit_date", "exit_price"].includes(field)) return;
    el.classList.toggle("input-yellow", !String(el.value ?? "").trim());
  };

  body.addEventListener("input", (e) => syncBlankHighlight(e.target));
  body.addEventListener("change", (e) => syncBlankHighlight(e.target));

  body.addEventListener("change", async (e) => {
    if (!e.target?.matches?.("[data-field]")) return;
    await handleFieldChange(e.target, onChanged);
  });

  // Date clears in WebView/Edge sometimes skip `change` until blur — commit on focusout too
  body.addEventListener("focusout", async (e) => {
    const el = e.target;
    if (!el?.matches?.('[data-field="exit_date"], [data-field="entry_date"]')) return;
    if (!el.isConnected || !el.closest("tr")) return;
    syncBlankHighlight(el);
    await handleFieldChange(el, onChanged);
  });

  body.addEventListener("click", async (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    const id = Number(tr.dataset.id);

    const archiveBtn = e.target.closest(".btn-archive");
    if (archiveBtn) {
      try {
        await updateTrade(id, { archived: 1 });
        onChanged?.();
      } catch (err) {
        alert(err.message || String(err));
      }
      return;
    }

    const restoreBtn = e.target.closest(".btn-restore");
    if (restoreBtn) {
      try {
        await updateTrade(id, { archived: 0 });
        onChanged?.();
      } catch (err) {
        alert(err.message || String(err));
      }
      return;
    }

    const delBtn = e.target.closest(".btn-del");
    if (!delBtn) return;
    e.preventDefault();
    e.stopPropagation();

    const trade = listTrades().find((t) => Number(t.id) === id);
    const pair = (trade?.pair || "").trim();
    const detail = pair ? `“${pair}”` : "this trade";
    const ok = await askConfirm(
      `Delete ${detail} from the journal?\n\nThis cannot be undone.`,
      "Delete Trade Entry",
    );
    if (!ok) return;

    try {
      await deleteTrade(id);
      onChanged?.();
    } catch (err) {
      alert(err.message || String(err));
    }
  });
}

export function bindJournal(onChanged) {
  const table = document.getElementById("journalTable");

  table?.querySelector("thead")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".sort-btn");
    if (!btn) return;
    const key = btn.getAttribute("data-sort");
    if (!key) return;
    if (sortState.key === key) {
      sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
    } else {
      sortState = { key, dir: "asc" };
    }
    onChanged?.();
  });

  bindTableBody(document.getElementById("journalBody"), onChanged);
  bindTableBody(document.getElementById("parkedBody"), onChanged);
  bindTableBody(document.getElementById("cancelledBody"), onChanged);

  document.getElementById("filterPair").addEventListener("input", () => onChanged?.());
  document.getElementById("filterTimeframe").addEventListener("change", () => onChanged?.());
  document.getElementById("btnRefreshJournal").addEventListener("click", () => onChanged?.());
}
