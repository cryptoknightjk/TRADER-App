/**
 * USDT-M / Coin-M calculator formulas ported from Crypto TA Secrets
 * Compiled Spreadsheets.
 */

const RISK_BY_QUALITY = {
  "A+": 0.015,
  A: 0.01,
  B: 0.005,
  C: 0,
};

/** Persist only USDT-M account net worth across app launches. */
const LS_ACCOUNT_NET_WORTH = "cts-hub-account-net-worth";

function loadSavedAccountNetWorth() {
  try {
    return localStorage.getItem(LS_ACCOUNT_NET_WORTH) ?? "";
  } catch {
    return "";
  }
}

function saveAccountNetWorth(value) {
  try {
    const v = value == null ? "" : String(value).trim();
    if (!v) localStorage.removeItem(LS_ACCOUNT_NET_WORTH);
    else localStorage.setItem(LS_ACCOUNT_NET_WORTH, v);
  } catch {
    /* ignore quota / private mode */
  }
}

/** Clear trade fields; keep / restore only net worth. Called on every app open. */
function resetCalculatorForSession() {
  const usdt = document.getElementById("marginModeUsdt");
  const coin = document.getElementById("marginModeCoin");
  if (usdt) usdt.checked = true;
  if (coin) coin.checked = false;

  const saved = loadSavedAccountNetWorth();
  const accountEl = document.getElementById("accountSize");
  if (accountEl) accountEl.value = saved;

  for (const id of ["entryPrice", "stopLoss", "takeProfit", "pair", "strategy", "setupIdea"]) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  }
  const quality = document.getElementById("quality");
  if (quality) quality.value = "B";
}

export function riskPctForQuality(quality) {
  return RISK_BY_QUALITY[quality] ?? 0;
}

/** Short trade-plan guides shown next to Entry / SL / TP for preset strategies. */
const STRATEGY_PLANS = {
  avwap: {
    entry: "Limit on the AVWAP",
    sl: "Beyond last wick through AVWAP",
    tp: "Next S/R away from AVWAP",
  },
  breakout: {
    entry: "Candle close of the breakout",
    sl: "1.5 ATR from entry",
    tp: "Next S/R",
  },
  highway: {
    entry: "Limit at the near rail of the highway",
    sl: "Outside the entry rail",
    tp: "Opposite rail of the highway",
  },
  prata: {
    entry: "Limit on retest of the flipped S/R",
    sl: "Beyond the flip zone",
    tp: "Next S/R in the flip direction",
  },
  "slam dunk": {
    entry: "At the slam dunk trigger",
    sl: "15% above entry",
    tp: "60% down from entry",
  },
};

function planForStrategy(name) {
  const key = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  return STRATEGY_PLANS[key] || null;
}

function applyStrategyPlan(strategyName, direction) {
  const plan = planForStrategy(strategyName);
  const isLong = direction === "LONG";
  const lines = plan ? { ...plan } : null;
  if (lines && String(strategyName || "").trim().toLowerCase() === "slam dunk" && isLong) {
    lines.sl = "15% below entry";
    lines.tp = "60% up from entry";
  }

  document.querySelectorAll(".plan-hint").forEach((el) => {
    const key = el.getAttribute("data-plan");
    el.textContent = lines?.[key] || "";
  });

  const box = document.getElementById("strategyPlanBox");
  if (box) {
    box.classList.toggle("has-plan", !!lines);
    if (lines) {
      box.querySelectorAll("[data-plan-line]").forEach((el) => {
        const key = el.getAttribute("data-plan-line");
        el.textContent = lines[key] || "";
      });
    } else {
      const entry = box.querySelector('[data-plan-line="entry"]');
      const sl = box.querySelector('[data-plan-line="sl"]');
      const tp = box.querySelector('[data-plan-line="tp"]');
      if (entry) entry.textContent = "Pick a strategy above";
      if (sl) sl.textContent = "—";
      if (tp) tp.textContent = "—";
    }
  }
}

/** Recommended leverage: always a positive integer (modulus / absolute value). */
export function leverageInteger(entry, sl) {
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || entry === sl) return null;
  // Excel: ROUND(entry/ABS(entry-sl)-1, 0); force non-negative via |·|, min 1
  const levRaw = Math.round(entry / Math.abs(entry - sl) - 1);
  const lev = Math.abs(levRaw);
  return lev === 0 ? 1 : lev;
}

export function compute(inputs) {
  const mode = inputs.marginMode === "coin" ? "coin" : "usdt";
  const account = Number(inputs.accountSize) || 0;
  const entry = Number(inputs.entryPrice);
  const sl = Number(inputs.stopLoss);
  const tp = Number(inputs.takeProfit);
  const quality = inputs.quality || "B";

  const validPrices = Number.isFinite(entry) && Number.isFinite(sl) && entry !== sl;

  let rMultiple = null;
  let direction = null;
  let riskPct = riskPctForQuality(quality);
  let dollarRisk = null; // USDT-M: USD risk; Coin-M: asset (token) risk
  let leverage = null;
  let size = null;
  let value = null;
  let equityTradePct = null;

  if (validPrices) {
    direction = entry - sl > 0 ? "LONG" : "SHORT";
    if (Number.isFinite(tp)) {
      rMultiple = Math.abs((tp - entry) / (entry - sl));
    }
    leverage = leverageInteger(entry, sl);

    if (mode === "coin") {
      // Coin-M: C18 = C17*C5 (tokens to risk)
      dollarRisk = riskPct * account;
      // C24 = C17/((C9-C10)/C10)*C5
      size = riskPct / ((entry - sl) / sl) * account;
      value = entry * size;
      // C23 = ABS(C25)/C5/C22
      equityTradePct = account && leverage ? Math.abs(value) / account / leverage : null;
    } else {
      // USDT-M: C18 = C17*C5 (USD risk)
      dollarRisk = riskPct * account;
      // C24 = C18/(C9-C10)
      size = dollarRisk / (entry - sl);
      value = entry * size;
      // C23 = ABS(C25)/C5/C22
      equityTradePct = account && leverage ? Math.abs(value) / account / leverage : null;
    }
  }

  return {
    marginMode: mode,
    rMultiple,
    direction,
    riskPct,
    dollarRisk,
    leverage,
    size,
    value,
    equityTradePct,
  };
}

/** Journal-side derived metrics matching Excel spill formulas. */
export function deriveTradeMetrics(trade) {
  const entry = Number(trade.entry_price);
  const sl = Number(trade.stop_loss);
  const tp = Number(trade.take_profit);
  const exit = trade.exit_price === null || trade.exit_price === ""
    ? null
    : Number(trade.exit_price);
  const quality = trade.quality;
  const direction = (trade.direction || "").toUpperCase();

  const rr = Number.isFinite(entry) && Number.isFinite(sl) && entry !== sl && Number.isFinite(tp)
    ? Math.abs((tp - entry) / (entry - sl))
    : null;

  const riskAdj = quality === "A+" ? 1.5
    : quality === "A" ? 1
      : quality === "B" ? 0.5
        : quality === "C" ? 0
          : null;

  let leverage = null;
  let sizePct = null;
  let marginPct = null;
  if (Number.isFinite(entry) && Number.isFinite(sl) && entry !== sl) {
    leverage = leverageInteger(entry, sl);
    // N = 1 / (ABS(E-F)/E) = E/ABS(E-F)
    sizePct = entry / Math.abs(entry - sl);
    marginPct = leverage ? sizePct / leverage : null;
  }

  let wl = null;
  let priceChange = null;
  let roe = null;
  let acctPct = null;

  // Closed results only when a real exit date is recorded (not just exit price / reason / N.A.)
  const exitRaw = String(trade.exit_date ?? "").trim();
  const hasExitDate = /^\d{4}-\d{2}-\d{2}$/.test(exitRaw.slice(0, 10))
    && !Number.isNaN(new Date(`${exitRaw.slice(0, 10)}T00:00:00`).getTime());
  if (hasExitDate && exit !== null && Number.isFinite(exit) && Number.isFinite(entry)) {
    if (exit > entry) wl = direction === "LONG" ? "W" : "L";
    else if (exit < entry) wl = direction === "SHORT" ? "W" : "L";
    else wl = "BE";

    priceChange = direction === "LONG"
      ? (exit - entry) / entry
      : (entry - exit) / entry;

    if (sizePct !== null) {
      roe = priceChange * sizePct;
      // Excel V: T * N / 100 * L  (L is risk adj 1.5/1/0.5)
      acctPct = riskAdj !== null ? priceChange * sizePct / 100 * riskAdj : null;
    }
  }

  return {
    rr,
    riskAdj,
    leverage,
    sizePct,
    marginPct,
    wl,
    priceChange,
    roe,
    acctPct,
  };
}

export function readCalculatorForm(root = document) {
  const modeEl = root.querySelector('input[name="marginMode"]:checked');
  return {
    marginMode: modeEl?.value === "coin" ? "coin" : "usdt",
    accountSize: root.getElementById("accountSize").value,
    entryPrice: root.getElementById("entryPrice").value,
    stopLoss: root.getElementById("stopLoss").value,
    takeProfit: root.getElementById("takeProfit").value,
    quality: root.getElementById("quality").value,
    pair: root.getElementById("pair").value.trim(),
    strategy: root.getElementById("strategy").value.trim(),
    setupIdea: root.getElementById("setupIdea").value.trim(),
  };
}

function fmt(n, digits = 4) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 100) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(Math.min(4, digits));
  return n.toPrecision(4);
}

function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(3)}%`;
}

function fmtUsd(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)} USDT`;
}

function applyModeLabels(mode) {
  const accountLabel = document.getElementById("accountSizeLabel");
  const riskLabel = document.getElementById("riskAmountLabel");
  const hint = document.getElementById("marginModeHint");
  if (mode === "coin") {
    if (accountLabel) accountLabel.textContent = "Asset Equity (number of tokens)";
    if (riskLabel) riskLabel.textContent = "Amount of Asset to Risk (tokens)";
    if (hint) {
      hint.textContent =
        "Account size in coins (e.g. BTC/ETH). Position size from Coin-M risk formula.";
    }
  } else {
    if (accountLabel) accountLabel.textContent = "Current Trading Account Net Worth (USDT)";
    if (riskLabel) riskLabel.textContent = "Dollar Risk (USD)";
    if (hint) {
      hint.textContent =
        "Account size in USDT. Position size from dollar risk ÷ (entry − stop).";
    }
  }
}

/** When switching margin type, save/restore USDT net worth; coin equity is session-only. */
function handleMarginModeSwitch(mode, prevMode) {
  const accountEl = document.getElementById("accountSize");
  if (!accountEl) return;
  if (prevMode === "usdt") {
    saveAccountNetWorth(accountEl.value);
  }
  if (mode === "usdt") {
    accountEl.value = loadSavedAccountNetWorth();
  } else if (prevMode === "usdt") {
    accountEl.value = "";
  }
}

export function bindCalculator(onChange) {
  const ids = [
    "accountSize", "entryPrice", "stopLoss", "takeProfit", "quality",
    "pair", "strategy", "setupIdea",
  ];

  resetCalculatorForSession();
  let lastMode = "usdt";

  const refresh = () => {
    const inputs = readCalculatorForm();
    if (inputs.marginMode !== lastMode) {
      handleMarginModeSwitch(inputs.marginMode, lastMode);
      lastMode = inputs.marginMode;
      Object.assign(inputs, readCalculatorForm());
    }
    applyModeLabels(inputs.marginMode);

    // Persist net worth whenever editing in USDT-M mode
    if (inputs.marginMode === "usdt") {
      saveAccountNetWorth(inputs.accountSize);
    }

    const out = compute(inputs);
    applyStrategyPlan(inputs.strategy, out.direction);
    const rrEl = document.getElementById("outRMultiple");
    rrEl.classList.remove("rr-ok", "rr-low");
    if (out.rMultiple === null) {
      rrEl.textContent = "—";
    } else {
      rrEl.textContent = out.rMultiple.toFixed(3);
      rrEl.classList.add(out.rMultiple >= 1.5 ? "rr-ok" : "rr-low");
    }
    const dirEl = document.getElementById("outDirection");
    dirEl.textContent = out.direction || "—";
    dirEl.classList.toggle("short", out.direction === "SHORT");
    document.getElementById("outRiskPct").textContent = fmtPct(out.riskPct);

    const riskOut = document.getElementById("outDollarRisk");
    if (out.dollarRisk === null) {
      riskOut.textContent = "—";
    } else if (inputs.marginMode === "coin") {
      riskOut.textContent = fmt(out.dollarRisk, 8);
    } else {
      riskOut.textContent = out.dollarRisk.toFixed(2);
    }

    document.getElementById("outLeverage").textContent =
      out.leverage === null ? "—" : String(Math.trunc(out.leverage));
    document.getElementById("outEquityTrade").textContent = fmtPct(out.equityTradePct);
    document.getElementById("outEntryPrice").textContent =
      inputs.entryPrice === "" || Number.isNaN(Number(inputs.entryPrice))
        ? "—"
        : fmt(Number(inputs.entryPrice), 8);
    document.getElementById("outSize").textContent =
      out.size === null ? "—" : fmt(Math.abs(out.size), 6);
    document.getElementById("outValue").textContent =
      out.value === null ? "—" : Math.abs(out.value).toFixed(2);
    document.getElementById("outTakeProfit").textContent =
      inputs.takeProfit === "" || Number.isNaN(Number(inputs.takeProfit))
        ? "—"
        : fmt(Number(inputs.takeProfit), 8);
    document.getElementById("outStopLoss").textContent =
      inputs.stopLoss === "" || Number.isNaN(Number(inputs.stopLoss))
        ? "—"
        : fmt(Number(inputs.stopLoss), 8);

    // Est. PnL from signed size × price move (same sizing as the calculator)
    let pnlTp = null;
    let pnlSl = null;
    const entry = Number(inputs.entryPrice);
    const tp = Number(inputs.takeProfit);
    const sl = Number(inputs.stopLoss);
    if (out.size !== null && Number.isFinite(entry)) {
      if (Number.isFinite(tp)) pnlTp = out.size * (tp - entry);
      if (Number.isFinite(sl)) pnlSl = out.size * (sl - entry);
    }
    const pnlTpEl = document.getElementById("outPnlTp");
    const pnlSlEl = document.getElementById("outPnlSl");
    pnlTpEl.textContent = fmtUsd(pnlTp);
    pnlSlEl.textContent = fmtUsd(pnlSl);
    pnlTpEl.classList.toggle("out-tp", pnlTp !== null && pnlTp >= 0);
    pnlTpEl.classList.toggle("out-sl", pnlTp !== null && pnlTp < 0);
    pnlSlEl.classList.toggle("out-sl", pnlSl !== null && pnlSl <= 0);
    pnlSlEl.classList.toggle("out-tp", pnlSl !== null && pnlSl > 0);

    onChange?.(inputs, out);
  };

  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", refresh);
    el.addEventListener("change", refresh);
  });

  const pairEl = document.getElementById("pair");
  if (pairEl) {
    pairEl.addEventListener("input", () => {
      const start = pairEl.selectionStart;
      const end = pairEl.selectionEnd;
      const upper = pairEl.value.toUpperCase();
      if (pairEl.value !== upper) {
        pairEl.value = upper;
        if (typeof start === "number" && typeof end === "number") {
          pairEl.setSelectionRange(start, end);
        }
      }
    });
  }

  document.querySelectorAll('input[name="marginMode"]').forEach((el) => {
    el.addEventListener("change", refresh);
  });

  applyModeLabels(lastMode);
  refresh();
  return refresh;
}

export function validateForLog(inputs, computed) {
  const missing = [];
  if (!inputs.pair) missing.push("Symbol");
  if (inputs.entryPrice === "" || Number.isNaN(Number(inputs.entryPrice))) missing.push("Entry Price");
  if (inputs.stopLoss === "" || Number.isNaN(Number(inputs.stopLoss))) missing.push("Stop Loss");
  if (inputs.takeProfit === "" || Number.isNaN(Number(inputs.takeProfit))) missing.push("Take Profit");
  if (!inputs.quality) missing.push("Quality");
  if (!computed.direction) missing.push("valid Entry/SL (for Direction)");
  return missing;
}
