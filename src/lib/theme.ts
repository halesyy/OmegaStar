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

export function setTheme(pref: ThemePref) {
  storageSet(KEY, pref);
  applyTheme(pref);
  theme.set(pref);
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
