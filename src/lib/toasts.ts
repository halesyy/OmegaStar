import { createStore, useStore } from "./store";

export type Toast = { id: number; text: string; tone: "neutral" | "ok" | "err"; action?: { label: string; run: () => void } };
const toasts = createStore<Toast[]>([]);
let toastN = 0;

export function toast(text: string, tone: Toast["tone"] = "neutral", action?: Toast["action"]) {
  const t: Toast = { id: ++toastN, text, tone, action };
  toasts.set([...toasts.get(), t]);
  window.setTimeout(() => dismissToast(t.id), 4200);
}
export function dismissToast(id: number) {
  toasts.set(toasts.get().filter((x) => x.id !== id));
}
export const useToasts = () => useStore(toasts);
