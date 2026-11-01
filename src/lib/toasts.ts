import { createStore, useStore } from "./store";

export type Toast = { id: number; text: string; tone: "neutral" | "ok" | "err"; action?: { label: string; run: () => void } };
const toasts = createStore<Toast[]>([]);
let toastN = 0;

/** Toasts on screen at once: a new one pushes out the oldest, so a burst of answers never stacks over the page. */
const MAX_TOASTS = 3;

export function toast(text: string, tone: Toast["tone"] = "neutral", action?: Toast["action"]) {
  const t: Toast = { id: ++toastN, text, tone, action };
  toasts.set([...toasts.get(), t].slice(-MAX_TOASTS));
  window.setTimeout(() => dismissToast(t.id), 4200);
}
export function dismissToast(id: number) {
  toasts.set(toasts.get().filter((x) => x.id !== id));
}
export const useToasts = () => useStore(toasts);
