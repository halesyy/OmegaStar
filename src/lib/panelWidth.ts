import { storageGet, storageSet } from "./storage";

// The member panel's width, set by dragging its left edge. Unset, tokens.css sizes it to the window.
const KEY = "omega.panelWidth";
export const PANEL_MIN = 460;
// The page beside the panel keeps at least the room the default leaves it on a small window.
const PAGE_ROOM = 620;

export function panelMax() {
  return Math.max(PANEL_MIN, window.innerWidth - PAGE_ROOM);
}

function read(): number | null {
  const n = Number(storageGet(KEY));
  return n > 0 ? n : null;
}

/** Sizes the panel without saving; null restores the default. The page beside it reads the same --panel-w. */
export function applyPanelWidth(px: number | null = read()) {
  const root = document.documentElement.style;
  if (px === null) root.removeProperty("--panel-w");
  else root.setProperty("--panel-w", `clamp(${PANEL_MIN}px, ${px}px, 100vw - ${PAGE_ROOM}px)`);
}

export function setPanelWidth(px: number | null) {
  storageSet(KEY, px === null ? "" : String(px));
  applyPanelWidth(px);
}
