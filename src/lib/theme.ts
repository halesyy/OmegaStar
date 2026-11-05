import { useEffect, useState } from "react";
import { storageGet, storageSet } from "./storage";
import { createStore, useStore } from "./store";

export type ThemePref = "system" | "light" | "dark";
const KEY = "omega.theme";

function read(): ThemePref {
  const v = storageGet(KEY);
  return v === "light" || v === "dark" ? v : "system";
}
const theme = createStore<ThemePref>(read());

export function applyTheme(pref: ThemePref = theme.get()) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

/** Saves and applies a theme. `fade`: the whole window crossfades to it (a view transition, about 200ms) rather than
 *  flipping in one frame; off under reduced motion, where the browser has no view transitions, and for set-up calls. */
export function setTheme(pref: ThemePref, fade = true) {
  storageSet(KEY, pref);
  const apply = () => { applyTheme(pref); theme.set(pref); };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (fade && doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(apply);
  else apply();
}

export const useTheme = () => useStore(theme);

/** Whether the window is dark right now: your choice, or the computer's when you left it on System. */
export function useResolvedDark(): boolean {
  const pref = useTheme();
  const [sys, setSys] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSys(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return pref === "dark" || (pref === "system" && sys);
}
