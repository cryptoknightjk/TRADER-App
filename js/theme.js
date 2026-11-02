const LS_THEME = "cts-hub-theme";

export function getTheme() {
  try {
    const t = localStorage.getItem(LS_THEME);
    return t === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function syncThemeIcons(btn, dark) {
  const moon = btn.querySelector(".theme-icon-moon");
  const sun = btn.querySelector(".theme-icon-sun");
  if (moon) {
    moon.classList.toggle("is-hidden", dark);
    moon.toggleAttribute("hidden", dark);
  }
  if (sun) {
    sun.classList.toggle("is-hidden", !dark);
    sun.toggleAttribute("hidden", !dark);
  }
}

export function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(LS_THEME, next);
  } catch {
    // ignore
  }
  const btn = document.getElementById("btnThemeToggle");
  if (!btn) return;

  const dark = next === "dark";
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  btn.setAttribute("aria-pressed", dark ? "true" : "false");
  btn.setAttribute("aria-label", label);
  btn.title = label;
  syncThemeIcons(btn, dark);
}

export function toggleTheme() {
  applyTheme(getTheme() === "dark" ? "light" : "dark");
}

export function bindTheme() {
  applyTheme(getTheme());
  document.getElementById("btnThemeToggle")?.addEventListener("click", () => {
    toggleTheme();
  });
}
