// Answers on their way: Inbox decisions you have answered (or hire proposals you have decided) whose Undo window is
// still open. The Inbox marks them as it settles an item and clears them when the answer is sent or undone; the
// sidebar's Inbox badge leaves them out, so it matches the Inbox's own count throughout the Undo.
import { createStore, useStore } from "./store";

const pending = createStore<ReadonlySet<string>>(new Set());

/** `id`: the Decision's id (`decisions()` in lib/decisions.ts), or a hire proposal's id. */
export function markPending(id: string) {
  if (pending.get().has(id)) return;
  pending.set(new Set([...pending.get(), id]));
}
export function clearPending(id: string) {
  if (!pending.get().has(id)) return;
  const next = new Set(pending.get());
  next.delete(id);
  pending.set(next);
}
export const usePending = () => useStore(pending);
