/**
 * Trade setup assessment checklist — criteria from Crypto TA Secrets
 * Compiled Spreadsheets (Trade Quality sheet).
 */

import { riskPctForQuality } from "./calculator.js";

export const RATING_CRITERIA = [
  {
    id: "narrative",
    group: "1. Narrative Alignment",
    support: "Aligns with market narrative",
    oppose: "Opposing current narrative",
  },
  {
    id: "sr_touches",
    group: "2. Structure & Levels",
    support: "At least 3 touches per SR line",
    oppose: "Less than 3 touches per SR line or with multiple deviations",
  },
  {
    id: "sr_confluence",
    group: "2. Structure & Levels",
    support: "Multiple S/R levels in confluence",
    oppose: "Lack of confluence with other S/R levels",
  },
  {
    id: "sr_htf",
    group: "2. Structure & Levels",
    support: "No opposing higher timeframe levels",
    oppose: "Higher timeframe SR levels could counter the trade",
  },
  {
    id: "pa_validate",
    group: "3. Price Action",
    support: "Candlestick price action validating SR levels",
    oppose: "Candles ignoring SR levels",
  },
  {
    id: "pa_wicks",
    group: "3. Price Action",
    support: "No significant opposing wicks showing rejection",
    oppose: "Appearance of candle wicks opposing direction of trade",
  },
  {
    id: "pa_recent",
    group: "3. Price Action",
    support: "Recent candles support direction of trade",
    oppose: "Recent candles indecisive or opposing direction of trade",
  },
  {
    id: "mom_volume",
    group: "4. Momentum & Volatility",
    support: "Strong volume follow through in direction of trade",
    oppose: "Lack of volume follow through",
  },
  {
    id: "mom_vol",
    group: "4. Momentum & Volatility",
    support: "Volatility expanding in same direction",
    oppose: "Volatility flat or reducing in direction of trade",
  },
  {
    id: "mom_trend",
    group: "4. Momentum & Volatility",
    support: "Direction of trade is in line with trend",
    oppose: "Direction of trade is against the trend",
  },
  {
    id: "strategy",
    group: "5. Strategy Fit",
    support: "Triggers for entry as per strategy rules",
    oppose: "Entry does not follow strategy rules",
  },
  {
    id: "funding",
    group: "6. Funding rate",
    support: "Funding rate incentivizing trade (paid to hold)",
    oppose: "Funding rate discouraging trade (paying to hold)",
  },
];

const GRADE_META = {
  "A+": {
    riskLabel: "1.5%",
    blurb: "At least 9 supporting criteria and no opposing criteria.",
  },
  A: {
    riskLabel: "1.0%",
    blurb: "At least 6 supporting criteria and no opposing criteria.",
  },
  B: {
    riskLabel: "0.5%",
    blurb: "1 opposing criterion.",
  },
  C: {
    riskLabel: "0% (no trade)",
    blurb: "1 or more opposing criteria.",
  },
};

/**
 * Grade from supporting / opposing counts (neutral ignored for rules).
 * A+: ≥9 supporting, 0 opposing
 * A:  ≥6 supporting, 0 opposing
 * B:  exactly 1 opposing
 * C:  ≥1 opposing (2+ when B takes the single-opposing case)
 * @param {number} support
 * @param {number} oppose
 * @param {number} total
 */
export function gradeFromCounts(support, oppose, total = RATING_CRITERIA.length) {
  if (support === 0 && oppose === 0) {
    return {
      grade: null,
      reason: "Select Supporting, Neutral, or Opposing for each criterion.",
    };
  }

  // A+ / A require zero opposing
  if (oppose === 0) {
    if (support >= 9) {
      return { grade: "A+", reason: GRADE_META["A+"].blurb };
    }
    if (support >= 6) {
      return { grade: "A", reason: GRADE_META.A.blurb };
    }
    if (support >= 1) {
      return {
        grade: null,
        reason: "Need at least 6 supporting criteria and no opposing for grade A.",
      };
    }
    return {
      grade: null,
      reason: "Mark at least one supporting criterion (or leave neutrals until you decide).",
    };
  }

  // B: exactly 1 opposing
  if (oppose === 1) {
    return { grade: "B", reason: GRADE_META.B.blurb };
  }

  // C: 1 or more opposing (here ≥2, since exactly 1 is B)
  return { grade: "C", reason: GRADE_META.C.blurb };
}

export function readSelections(root = document) {
  const map = {};
  for (const c of RATING_CRITERIA) {
    const el = root.querySelector(`input[name="rate_${c.id}"]:checked`);
    map[c.id] = el ? el.value : "neutral";
  }
  return map;
}

export function summarizeSelections(selections) {
  let support = 0;
  let oppose = 0;
  let neutral = 0;
  for (const c of RATING_CRITERIA) {
    const v = selections[c.id] || "neutral";
    if (v === "support") support += 1;
    else if (v === "oppose") oppose += 1;
    else neutral += 1;
  }
  const result = gradeFromCounts(support, oppose, RATING_CRITERIA.length);
  return { support, oppose, neutral, ...result };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCriteriaList() {
  const host = document.getElementById("ratingCriteria");
  if (!host) return;

  let lastGroup = null;
  const blocks = [];
  for (const c of RATING_CRITERIA) {
    if (c.group !== lastGroup) {
      lastGroup = c.group;
      blocks.push(`<h3 class="rating-group">${escapeHtml(c.group)}</h3>`);
    }
    blocks.push(`
      <fieldset class="rating-item" data-id="${c.id}">
        <legend class="visually-hidden">${escapeHtml(c.group)} criterion</legend>
        <div class="rating-choices">
          <label class="choice choice-support">
            <input type="radio" name="rate_${c.id}" value="support" />
            <span class="choice-tag">Supporting</span>
            <span class="choice-text">${escapeHtml(c.support)}</span>
          </label>
          <label class="choice choice-neutral">
            <input type="radio" name="rate_${c.id}" value="neutral" checked />
            <span class="choice-tag">Neutral</span>
            <span class="choice-text">Neither / not applicable</span>
          </label>
          <label class="choice choice-oppose">
            <input type="radio" name="rate_${c.id}" value="oppose" />
            <span class="choice-tag">Opposing</span>
            <span class="choice-text">${escapeHtml(c.oppose)}</span>
          </label>
        </div>
      </fieldset>
    `);
  }
  host.innerHTML = blocks.join("");
}

function updateResultPanel(onGradeChange) {
  const summary = summarizeSelections(readSelections());
  const gradeEl = document.getElementById("ratingGrade");
  const riskEl = document.getElementById("ratingRisk");
  const reasonEl = document.getElementById("ratingReason");
  const countsEl = document.getElementById("ratingCounts");

  document.querySelectorAll(".grade-pill").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.grade === summary.grade);
  });

  if (!summary.grade) {
    gradeEl.textContent = "—";
    gradeEl.dataset.grade = "";
    riskEl.textContent = "—";
    reasonEl.textContent = summary.reason;
  } else {
    gradeEl.textContent = summary.grade;
    gradeEl.dataset.grade = summary.grade;
    const risk = riskPctForQuality(summary.grade);
    riskEl.textContent = `${(risk * 100).toFixed(1)}% equity risk`;
    reasonEl.textContent = summary.reason;
  }

  countsEl.textContent =
    `Supporting ${summary.support} · Opposing ${summary.oppose} · Neutral ${summary.neutral}`;

  onGradeChange?.(summary.grade || null);
}

export function getCurrentGrade() {
  return summarizeSelections(readSelections()).grade;
}

export function resetRating(onGradeChange) {
  for (const c of RATING_CRITERIA) {
    const neutral = document.querySelector(`input[name="rate_${c.id}"][value="neutral"]`);
    if (neutral) neutral.checked = true;
  }
  updateResultPanel(onGradeChange);
}

export function bindRating({ onGradeChange, onOpenCalculator } = {}) {
  renderCriteriaList();
  updateResultPanel(onGradeChange);

  const host = document.getElementById("ratingCriteria");
  host?.addEventListener("change", () => updateResultPanel(onGradeChange));

  document.getElementById("btnResetRating")?.addEventListener("click", () => {
    resetRating(onGradeChange);
  });

  document.getElementById("btnOpenCalculatorFromAssess")?.addEventListener("click", () => {
    onOpenCalculator?.();
  });
}
