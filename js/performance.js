/**
 * Journal performance view — equity curve, summary metrics, and trade rankings.
 */

import { deriveTradeMetrics } from "./calculator.js";
import { hasDb, listTrades } from "./db.js";

function positionOf(trade) {
  const hasEntry = !!(trade.entry_date && /^\d{4}-\d{2}-\d{2}/.test(String(trade.entry_date).trim()));
  const exitRaw = String(trade.exit_date ?? "").trim();
  const hasExit = /^\d{4}-\d{2}-\d{2}$/.test(exitRaw.slice(0, 10))
    && !Number.isNaN(new Date(`${exitRaw.slice(0, 10)}T00:00:00`).getTime());
  if (hasEntry && hasExit) return "closed";
  if (hasEntry) return "open";
  return "pending";
}

function avg(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const signed = n < 0;
  const body = `${(Math.abs(n) * 100).toFixed(digits)}%`;
  return signed ? `-${body}` : body;
}

/** Always show + or − for cumulative / signed % metrics. */
function fmtPctSigned(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n < 0 ? "-" : "+";
  return `${sign}${(Math.abs(n) * 100).toFixed(digits)}%`;
}

function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll('"', "&quot;");
}

const CHART = {
  w: 920,
  h: 380,
  pad: { t: 28, r: 28, b: 68, l: 68 },
};

/** @type {{ curve: any[], zoomX: number, zoomY: number, panX: number, panY: number } | null} */
let equityState = null;
/** @type {((id: number) => void) | null} */
let openTradeHandler = null;

/** Build chronological rows with Excel-style cumulative account %. */
export function computePerformance() {
  const trades = listTrades().filter((t) => {
    if (Number(t.archived) === 1) return false;
    return !!(t.entry_date && String(t.entry_date).trim());
  });
  const rows = trades.map((t) => {
    const m = deriveTradeMetrics(t);
    const pos = positionOf(t);
    return { t, m, pos };
  });

  let cumul = 0;
  const curve = [{
    id: null,
    pair: "",
    n: 0,
    cumul: 0,
    acctPct: 0,
    origin: true,
  }];
  for (const row of rows) {
    if (row.m.acctPct !== null && Number.isFinite(row.m.acctPct)) {
      cumul += row.m.acctPct;
      curve.push({
        id: row.t.id,
        pair: row.t.pair || "",
        n: curve.length,
        cumul,
        acctPct: row.m.acctPct,
        origin: false,
      });
    }
  }
  if (curve.length === 1) curve.length = 0;

  const withRr = rows.map((r) => r.m.rr).filter((n) => n !== null && Number.isFinite(n));
  const withQuality = rows.filter((r) => r.t.quality);
  const aa = withQuality.filter((r) => r.t.quality === "A+" || r.t.quality === "A");
  const open = rows.filter((r) => r.pos === "open");
  const closed = rows.filter((r) => r.pos === "closed");
  const closedWithWl = closed.filter((r) => r.m.wl);
  const wins = closedWithWl.filter((r) => r.m.wl === "W");
  const maxWinStreak = maxStreak(closedWithWl.map((r) => r.m.wl), "W");
  const withAcct = rows
    .map((r) => r.m.acctPct)
    .filter((n) => n !== null && Number.isFinite(n));

  // Most common note: Trade Log only (has entry date, not cancelled/archived)
  const noteCounts = new Map();
  for (const { t } of rows) {
    const raw = String(t.notes || "").trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    const cur = noteCounts.get(key);
    if (cur) cur.count += 1;
    else noteCounts.set(key, { text: raw, count: 1 });
  }
  let commonNote = null;
  for (const v of noteCounts.values()) {
    if (
      !commonNote
      || v.count > commonNote.count
      || (v.count === commonNote.count && v.text.localeCompare(commonNote.text) < 0)
    ) {
      commonNote = v;
    }
  }

  const rankings = buildTickerAndTradeRankings(rows);
  const maxDd = maxDrawdownFromCurve(curve);

  return {
    total: rows.length,
    pending: rows.filter((r) => r.pos === "pending").length,
    open: open.length,
    closed: closed.length,
    avgRr: avg(withRr),
    pctAa: withQuality.length ? aa.length / withQuality.length : null,
    openPositions: open.length,
    wlRate: closedWithWl.length ? wins.length / closedWithWl.length : null,
    wins: wins.length,
    decided: closedWithWl.length,
    maxWinStreak,
    expectancy: avg(withAcct),
    cumul,
    maxDrawdown: maxDd,
    curve,
    commonNote,
    ...rankings,
  };
}

/** Longest consecutive run of `target` in chronological outcomes (e.g. "W"). */
function maxStreak(outcomes, target) {
  let best = 0;
  let cur = 0;
  for (const o of outcomes) {
    if (o === target) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

/** Peak-to-trough drawdown on cumulative account % (≤ 0). */
function maxDrawdownFromCurve(curve) {
  if (!curve?.length) return null;
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of curve) {
    const v = p.cumul;
    if (!Number.isFinite(v)) continue;
    peak = Math.max(peak, v);
    const dd = v - peak;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
}

/** Aggregate pair stats + largest trades by account-% impact (journal “PnL”). */
function buildTickerAndTradeRankings(rows) {
  const scored = rows.filter((r) => r.m.acctPct !== null && Number.isFinite(r.m.acctPct));
  const by = new Map();
  for (const { t, m } of scored) {
    const ticker = String(t.pair || "").trim().toUpperCase() || "—";
    let o = by.get(ticker);
    if (!o) {
      o = { ticker, trades: 0, wins: 0, pnl: 0 };
      by.set(ticker, o);
    }
    o.trades += 1;
    o.pnl += m.acctPct;
    if (m.acctPct > 0) o.wins += 1;
  }

  const tickerRows = [...by.values()].map((o) => ({
    ...o,
    winRate: o.trades ? o.wins / o.trades : 0,
    avgPnl: o.trades ? o.pnl / o.trades : 0,
  }));

  const topPnl = [...tickerRows].sort((a, b) => b.pnl - a.pnl).slice(0, 10);
  const btmPnl = [...tickerRows].sort((a, b) => a.pnl - b.pnl).slice(0, 10);
  const topTraded = [...tickerRows]
    .sort((a, b) => (b.trades !== a.trades ? b.trades - a.trades : b.pnl - a.pnl))
    .slice(0, 10);

  const bestTrades = scored
    .map(({ t, m }) => ({
      id: t.id,
      date: t.exit_date || t.entry_date || "",
      pair: t.pair || "",
      direction: (t.direction || "").toUpperCase(),
      entry: t.entry_price,
      exit: t.exit_price,
      ret: m.priceChange,
      pnl: m.acctPct,
    }))
    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
    .slice(0, 20);

  return { topPnl, btmPnl, topTraded, bestTrades };
}

function fmtPrice(n) {
  if (n === null || n === undefined || n === "" || Number.isNaN(Number(n))) return "—";
  const s = Number(n).toFixed(8);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

function pctClass(n) {
  if (n > 0) return "pct-pos";
  if (n < 0) return "pct-neg";
  return "";
}

function renderTickerRows(rows, { showWinRate = false, showAvg = false } = {}) {
  if (!rows.length) {
    return `<tr><td colspan="6" class="td-muted">No scored trades yet.</td></tr>`;
  }
  return rows.map((r, i) => {
    const wrTxt = `${(r.winRate * 100).toFixed(0)}% (${r.wins}/${r.trades})`;
    return `
      <tr>
        <td class="td-muted">${i + 1}</td>
        <td><span class="pill pill-pair">${escapeHtml(r.ticker)}</span></td>
        <td>${r.trades}</td>
        ${showWinRate ? `<td>${escapeHtml(wrTxt)}</td>` : ""}
        <td class="${pctClass(r.pnl)}">${fmtPctSigned(r.pnl, 2)}</td>
        ${showAvg ? `<td class="${pctClass(r.avgPnl)}">${fmtPctSigned(r.avgPnl, 2)}</td>` : ""}
      </tr>`;
  }).join("");
}

function renderTickerSection(data) {
  const topPnlRows = renderTickerRows(data.topPnl || []);
  const btmPnlRows = renderTickerRows(data.btmPnl || []);
  const tradedRows = renderTickerRows(data.topTraded || [], { showWinRate: true, showAvg: true });

  return `
    <div class="panel performance-section">
      <h2 class="performance-section-title">Top and Bottom Tickers</h2>
      <p class="hint">Ranked by Trade Win/Loss (account %). Closed / scored trades only.</p>
      <div class="performance-tabs" role="tablist">
        <button type="button" class="performance-tab is-active" data-ticker-tab="top_pnl">Top 10 PnL</button>
        <button type="button" class="performance-tab" data-ticker-tab="btm_pnl">Bottom 10 PnL</button>
        <button type="button" class="performance-tab" data-ticker-tab="top_traded">Top 10 Traded</button>
      </div>
      <div class="performance-tab-panel is-active" data-ticker-panel="top_pnl">
        <div class="table-wrap performance-mini-table">
          <table>
            <thead><tr><th>#</th><th>Ticker</th><th>Trades</th><th>Cumulative Account Change %</th></tr></thead>
            <tbody>${topPnlRows}</tbody>
          </table>
        </div>
      </div>
      <div class="performance-tab-panel" data-ticker-panel="btm_pnl" hidden>
        <div class="table-wrap performance-mini-table">
          <table>
            <thead><tr><th>#</th><th>Ticker</th><th>Trades</th><th>Cumulative Account Change %</th></tr></thead>
            <tbody>${btmPnlRows}</tbody>
          </table>
        </div>
      </div>
      <div class="performance-tab-panel" data-ticker-panel="top_traded" hidden>
        <div class="table-wrap performance-mini-table">
          <table>
            <thead><tr><th>#</th><th>Ticker</th><th>No. of Trades</th><th>Win Rate</th><th>Cumulative Account Change %</th><th>Average Account Change</th></tr></thead>
            <tbody>${tradedRows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderBestTradesSection(bestTrades) {
  const rows = (bestTrades || []);
  const body = !rows.length
    ? `<tr><td colspan="6" class="td-muted">No scored trades yet.</td></tr>`
    : rows.map((t) => {
      const dirCls = t.direction === "LONG" ? "dir-long" : t.direction === "SHORT" ? "dir-short" : "";
      return `
        <tr class="row-click" data-trade-id="${t.id}" title="Open in Journal">
          <td class="td-muted">${escapeHtml(t.date || "—")}</td>
          <td><span class="pill pill-pair">${escapeHtml(t.pair || "—")}</span></td>
          <td><span class="${dirCls}">${escapeHtml(t.direction || "—")}</span></td>
          <td>${fmtPrice(t.entry)}</td>
          <td>${fmtPrice(t.exit)}</td>
          <td class="${pctClass(t.pnl)}">${fmtPctSigned(t.pnl, 2)}</td>
        </tr>`;
    }).join("");

  return `
    <div class="panel performance-section">
      <h2 class="performance-section-title">Best trades by PnL impact</h2>
      <p class="hint">Top 20 trades by absolute Trade Win/Loss (account %). Click a row to open it in the Journal.</p>
      <div class="table-wrap performance-mini-table">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Ticker</th>
              <th>Side</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>Trade Return %</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

function bindPerformanceExtraUi(root) {
  root.querySelectorAll("[data-ticker-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const which = btn.getAttribute("data-ticker-tab");
      root.querySelectorAll("[data-ticker-tab]").forEach((b) => b.classList.toggle("is-active", b === btn));
      root.querySelectorAll("[data-ticker-panel]").forEach((panel) => {
        const on = panel.getAttribute("data-ticker-panel") === which;
        panel.hidden = !on;
        panel.classList.toggle("is-active", on);
      });
    });
  });

  root.querySelectorAll("tr.row-click[data-trade-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const id = Number(tr.getAttribute("data-trade-id"));
      if (id && openTradeHandler) openTradeHandler(id);
    });
  });
}

function dataExtents(curve) {
  const ys = curve.map((p) => p.cumul);
  let yMin = Math.min(0, ...ys);
  let yMax = Math.max(0, ...ys);
  if (yMin === yMax) {
    yMin -= 0.01;
    yMax += 0.01;
  }
  const yPad = (yMax - yMin) * 0.08;
  return {
    xMin: 0,
    xMax: Math.max(1, curve.length - 1),
    yMin: yMin - yPad,
    yMax: yMax + yPad,
  };
}

function visibleDomains(state) {
  const ext = dataExtents(state.curve);
  const xSpan = (ext.xMax - ext.xMin) / state.zoomX;
  const ySpan = (ext.yMax - ext.yMin) / state.zoomY;
  const xMid = (ext.xMin + ext.xMax) / 2 + state.panX;
  const yMid = (ext.yMin + ext.yMax) / 2 + state.panY;
  return {
    x0: xMid - xSpan / 2,
    x1: xMid + xSpan / 2,
    y0: yMid - ySpan / 2,
    y1: yMid + ySpan / 2,
    ext,
  };
}

function clampChartView(state) {
  state.zoomX = Math.min(12, Math.max(1, state.zoomX));
  state.zoomY = Math.min(12, Math.max(1, state.zoomY));
}

function projectPoint(i, cumul, domains) {
  const { pad } = CHART;
  const innerW = CHART.w - pad.l - pad.r;
  const innerH = CHART.h - pad.t - pad.b;
  const { x0, x1, y0, y1 } = domains;
  const x = pad.l + ((i - x0) / (x1 - x0 || 1)) * innerW;
  const y = pad.t + ((y1 - cumul) / (y1 - y0 || 1)) * innerH;
  return { x, y };
}

function paintEquitySvg() {
  const svg = document.getElementById("equityChartSvg");
  if (!svg || !equityState?.curve?.length) return;

  clampChartView(equityState);
  const { curve, zoomX, zoomY } = equityState;
  const domains = visibleDomains(equityState);
  const { pad, w, h } = CHART;
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;

  const pts = curve.map((p, i) => {
    const { x, y } = projectPoint(i, p.cumul, domains);
    return { ...p, i, x, y };
  });

  const linePts = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const zeroY = projectPoint(0, 0, domains).y;

  const yTicks = 5;
  const tickEls = [];
  for (let i = 0; i <= yTicks; i++) {
    const v = domains.y0 + ((domains.y1 - domains.y0) * i) / yTicks;
    const y = projectPoint(0, v, domains).y;
    if (y < pad.t - 2 || y > pad.t + innerH + 2) continue;
    tickEls.push(`
      <line class="chart-grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" />
      <text class="chart-tick" x="${pad.l - 8}" y="${y.toFixed(1)}" dy="0.35em" text-anchor="end">${fmtPct(v, 1)}</text>
    `);
  }

  const xLabels = [];
  const span = domains.x1 - domains.x0;
  const step = Math.max(1, Math.ceil(span / 8));
  const xStart = Math.max(0, Math.floor(domains.x0));
  const xEnd = Math.min(curve.length - 1, Math.ceil(domains.x1));
  for (let i = xStart; i <= xEnd; i += step) {
    const { x } = projectPoint(i, 0, domains);
    if (x < pad.l - 4 || x > pad.l + innerW + 4) continue;
    xLabels.push(`
      <text class="chart-tick" x="${x.toFixed(1)}" y="${pad.t + innerH + 18}" text-anchor="middle">${curve[i].n}</text>
    `);
  }

  const pointEls = pts
    .filter((p) => !p.origin && p.id != null)
    .map((p) => {
      const pair = escapeAttr(p.pair || "—");
      const wlCls = p.acctPct > 0 ? "is-win" : p.acctPct < 0 ? "is-loss" : "is-flat";
      return `
        <circle class="chart-point ${wlCls}"
          data-id="${p.id}"
          data-pair="${pair}"
          data-acct="${p.acctPct}"
          data-cumul="${p.cumul}"
          cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4"
          role="button"
          aria-label="${pair}"></circle>`;
    })
    .join("");

  svg.innerHTML = `
    <defs>
      <clipPath id="equityPlotClip">
        <rect x="${pad.l}" y="${pad.t}" width="${innerW}" height="${innerH}" />
      </clipPath>
    </defs>
    ${tickEls.join("")}
    <g clip-path="url(#equityPlotClip)">
      <line class="chart-zero" x1="${pad.l}" y1="${zeroY.toFixed(1)}" x2="${w - pad.r}" y2="${zeroY.toFixed(1)}" pointer-events="none" />
      <polyline class="chart-line" fill="none" points="${linePts}" pointer-events="none" />
      ${pointEls}
    </g>
    ${xLabels.join("")}
    <text class="chart-axis-label" x="${pad.l + innerW / 2}" y="${h - 8}" text-anchor="middle">Number of Trades</text>
    <text class="chart-axis-label" transform="translate(16 ${pad.t + innerH / 2}) rotate(-90)" text-anchor="middle">Account % Gain/Loss</text>
  `;

  const zx = document.getElementById("equityZoomX");
  const zy = document.getElementById("equityZoomY");
  if (zx) zx.value = String(zoomX);
  if (zy) zy.value = String(zoomY);
  const zxLab = document.getElementById("equityZoomXLabel");
  const zyLab = document.getElementById("equityZoomYLabel");
  if (zxLab) zxLab.textContent = `${zoomX.toFixed(1)}×`;
  if (zyLab) zyLab.textContent = `${zoomY.toFixed(1)}×`;
}

function hideEquityTooltip() {
  const tip = document.getElementById("equityTooltip");
  if (!tip) return;
  tip.hidden = true;
  tip.style.display = "none";
}

function showEquityTooltip(evt, el) {
  const tip = document.getElementById("equityTooltip");
  const wrap = document.getElementById("equityChartWrap");
  if (!tip || !wrap || !el) return;
  const pair = el.getAttribute("data-pair") || "—";
  const acct = Number(el.getAttribute("data-acct"));
  const cumul = Number(el.getAttribute("data-cumul"));
  tip.hidden = false;
  tip.style.display = "flex";
  tip.innerHTML = `
    <strong>${escapeHtml(pair)}</strong>
    <span>Trade ${fmtPctSigned(acct, 2)} · Cumul ${fmtPctSigned(cumul, 2)}</span>
    <em>Click to open in Journal</em>`;
  const wr = wrap.getBoundingClientRect();
  const x = evt.clientX - wr.left + 12;
  const y = evt.clientY - wr.top + 12;
  tip.style.left = `${Math.min(x, wr.width - 180)}px`;
  tip.style.top = `${Math.min(y, wr.height - 70)}px`;
}

function attachEquityPointerHandlers(svg, wrap) {
  const drag = { active: false, moved: false, x0: 0, y0: 0, panX0: 0, panY0: 0 };

  const zoomX = document.getElementById("equityZoomX");
  const zoomY = document.getElementById("equityZoomY");
  const resetBtn = document.getElementById("equityResetView");

  // Avoid duplicate control listeners: use oninput assignment
  if (zoomX) {
    zoomX.oninput = () => {
      equityState.zoomX = Number(zoomX.value) || 1;
      paintEquitySvg();
    };
  }
  if (zoomY) {
    zoomY.oninput = () => {
      equityState.zoomY = Number(zoomY.value) || 1;
      paintEquitySvg();
    };
  }
  if (resetBtn) {
    resetBtn.onclick = () => {
      equityState.zoomX = 1;
      equityState.zoomY = 1;
      equityState.panX = 0;
      equityState.panY = 0;
      paintEquitySvg();
    };
  }

  svg.addEventListener("pointermove", (e) => {
    if (drag.active) {
      const dx = e.clientX - drag.x0;
      const dy = e.clientY - drag.y0;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      const domains = visibleDomains(equityState);
      const innerW = CHART.w - CHART.pad.l - CHART.pad.r;
      const innerH = CHART.h - CHART.pad.t - CHART.pad.b;
      const xPerPx = (domains.x1 - domains.x0) / innerW;
      const yPerPx = (domains.y1 - domains.y0) / innerH;
      equityState.panX = drag.panX0 - dx * xPerPx;
      equityState.panY = drag.panY0 + dy * yPerPx;
      paintEquitySvg();
      return;
    }
    const pt = e.target?.classList?.contains("chart-point") ? e.target : null;
    if (pt) showEquityTooltip(e, pt);
    else hideEquityTooltip();
  });

  svg.addEventListener("pointerleave", () => {
    if (!drag.active) hideEquityTooltip();
  });

  svg.addEventListener("click", (e) => {
    const pt = e.target?.classList?.contains("chart-point") ? e.target : null;
    if (!pt || drag.moved) return;
    const id = Number(pt.getAttribute("data-id"));
    if (!id || !openTradeHandler) return;
    openTradeHandler(id);
  });

  svg.addEventListener("pointerdown", (e) => {
    drag.moved = false;
    if (e.target?.classList?.contains("chart-point")) return;
    drag.active = true;
    drag.x0 = e.clientX;
    drag.y0 = e.clientY;
    drag.panX0 = equityState.panX;
    drag.panY0 = equityState.panY;
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("is-panning");
    hideEquityTooltip();
  });

  const endDrag = (e) => {
    if (!drag.active) return;
    drag.active = false;
    svg.classList.remove("is-panning");
    try { svg.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const both = e.ctrlKey || e.metaKey;
    const yOnly = e.shiftKey && !both;
    if (both) {
      equityState.zoomX *= factor;
      equityState.zoomY *= factor;
    } else if (yOnly) {
      equityState.zoomY *= factor;
    } else {
      equityState.zoomX *= factor;
    }
    paintEquitySvg();
  }, { passive: false });
}

function renderEquityChartShell(curve) {
  const title = "Trading Account Equity Curve";
  if (!curve.length) {
    equityState = null;
    return `
      <div class="panel equity-panel">
        <h2>${title}</h2>
        <p class="hint">Equity curve appears once closed trades have an account % result.</p>
      </div>`;
  }

  equityState = {
    curve,
    zoomX: 1,
    zoomY: 1,
    panX: 0,
    panY: 0,
  };

  return `
    <div class="panel equity-panel">
      <div class="equity-panel-head">
        <h2>${title}</h2>
        <div class="equity-controls">
          <label class="equity-zoom">
            <span>X scale <strong id="equityZoomXLabel">1.0×</strong></span>
            <input type="range" id="equityZoomX" min="1" max="12" step="0.1" value="1" />
          </label>
          <label class="equity-zoom">
            <span>Y scale <strong id="equityZoomYLabel">1.0×</strong></span>
            <input type="range" id="equityZoomY" min="1" max="12" step="0.1" value="1" />
          </label>
          <button type="button" class="btn ghost" id="equityResetView">Reset view</button>
        </div>
      </div>
      <div class="equity-chart-wrap" id="equityChartWrap">
        <svg class="equity-chart" id="equityChartSvg" viewBox="0 0 ${CHART.w} ${CHART.h}" role="img" aria-label="${title}"></svg>
        <div class="equity-tooltip" id="equityTooltip" hidden></div>
      </div>
      <p class="hint equity-caption">
        Drag to pan · Scroll = widen X · Shift+scroll = widen Y · Ctrl+scroll = both · Hover a point for symbol · Click to open trade
      </p>
    </div>`;
}

function metricCard(label, value, note = "", { title = "" } = {}) {
  const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
  return `
    <div class="stat-card">
      <span>${escapeHtml(label)}</span>
      <strong${titleAttr}>${value}</strong>
      ${note ? `<em>${escapeHtml(note)}</em>` : ""}
    </div>`;
}

export function renderPerformance() {
  const root = document.getElementById("performanceRoot");
  const empty = document.getElementById("performanceEmpty");
  if (!root) return;

  if (!hasDb()) {
    root.innerHTML = "";
    equityState = null;
    if (empty) {
      empty.hidden = false;
      empty.textContent = "Create or link a journal to see performance.";
    }
    return;
  }

  const data = computePerformance();
  if (!data.total) {
    root.innerHTML = "";
    equityState = null;
    if (empty) {
      empty.hidden = false;
      empty.textContent = "No trades yet. Log trades from the Position Size Calculator to build performance.";
    }
    return;
  }

  if (empty) empty.hidden = true;

  const commonNoteText = data.commonNote ? escapeHtml(data.commonNote.text) : "—";
  const commonNoteHint = data.commonNote
    ? `${data.commonNote.count}× in Trade Log`
    : "no notes in Trade Log";

  root.innerHTML = `
    ${renderEquityChartShell(data.curve)}
    <div class="performance-cards excel-metrics">
      ${metricCard("Cumulative Account % Change", fmtPctSigned(data.cumul, 2))}
      ${metricCard(
        "W/L Rate",
        fmtPct(data.wlRate, 1),
        data.decided ? `${data.wins}W / ${data.decided} closed` : "closed trades only",
      )}
      ${metricCard("Max Win Streak", String(data.maxWinStreak ?? 0), "consecutive wins")}
      ${metricCard("Average Planned R:R", fmtNum(data.avgRr, 2))}
      ${metricCard("Average Trade Expectancy", fmtPct(data.expectancy, 2), "mean account %")}
      ${metricCard("% of A+/A trades", fmtPct(data.pctAa, 1))}
      ${metricCard("Max Drawdown", fmtPctSigned(data.maxDrawdown, 2), "peak to trough on equity curve")}
      ${metricCard(
        "Most Common Post-Trade Note",
        commonNoteText,
        commonNoteHint,
        { title: data.commonNote?.text || "" },
      )}
    </div>
    <p class="hint">Pending ${data.pending} · Open ${data.open} · Closed ${data.closed} · Total ${data.total}</p>
    ${renderTickerSection(data)}
    ${renderBestTradesSection(data.bestTrades)}
  `;

  if (data.curve.length) {
    paintEquitySvg();
    const svg = document.getElementById("equityChartSvg");
    const wrap = document.getElementById("equityChartWrap");
    if (svg && wrap) attachEquityPointerHandlers(svg, wrap);
  }
  bindPerformanceExtraUi(root);
}

export function bindPerformance(opts = {}) {
  openTradeHandler = typeof opts.onOpenTrade === "function" ? opts.onOpenTrade : null;
  document.getElementById("btnRefreshPerformance")?.addEventListener("click", () => {
    renderPerformance();
  });
}
