// The Inbox as decisions: one entry per thing waiting on you, read from the rows the Inbox shows. A question
// several employees asked is one entry, and answering it answers them all. Pure.
import type { Card, Run, Thread } from "../api/types";
import { blockedNow, broken, flags, latestFinished, openCards, rowThreads, STREAK, topic } from "./threads";

/** Something waiting on you in a row (`item`). `thread`: the row's thread it is in; `run`: the run it is about. */
export type Decision<T> = { id: string; item: T; thread: Thread; run: Run } & (
  | { type: "card"; index: number; card: Card; also: Run[] }   // also: the other runs asking the same thing
  | { type: "flag"; text: string }                            // something Omega Star flagged
  | { type: "blocked" }                                        // blocked on a tool you could allow
  | { type: "broken"; times: number }                          // broke; times: a schedule's failures in a row
  | { type: "answered" }                                       // the employee answered you
);

type CardDecision<T> = Extract<Decision<T>, { type: "card" }>;

const scheduled = (x: Thread): boolean => x.root.kind.type === "scheduled";

/** What a row waits on you for, newest first. Mirrors Rust `threads::needs_you`: cards anywhere, and what each
 *  thread's newest finished run flagged, was blocked on or broke; a schedule's failures count once `STREAK` of them
 *  are in a row, as one decision. A row that asks nothing is the employee answering you. */
function rowDecisions<T extends { thread: Thread }>(item: T): Decision<T>[] {
  const all = rowThreads(item.thread);
  const open = all.filter((x) => !x.root.archivedAt).reverse();
  const out: Decision<T>[] = [];
  for (const x of open) {
    for (const c of openCards(x)) out.push({ type: "card", id: `${c.run.id}:${c.index}`, item, thread: x, run: c.run, index: c.index, card: c.card, also: [] });
    const last = latestFinished(x);
    flags(last).forEach((text, i) => out.push({ type: "flag", id: `${last.id}:f${i}`, item, thread: x, run: last, text }));
    if (blockedNow(x)) out.push({ type: "blocked", id: `${last.id}:blocked`, item, thread: x, run: last });
  }
  const failures = all.filter((x) => scheduled(x) && broken(x.root)).length;
  let streak = false;
  for (const x of open) {
    const last = latestFinished(x);
    if (!broken(last) || (scheduled(x) && (failures < STREAK || streak))) continue;
    streak ||= scheduled(x);
    out.push({ type: "broken", id: `${last.id}:broken`, item, thread: x, run: last, times: scheduled(x) ? failures : 1 });
  }
  if (out.length) return out;
  return [{ type: "answered", id: `${item.thread.root.id}:answered`, item, thread: item.thread, run: latestFinished(item.thread) }];
}

/** Every decision in `items`, in their order. The same question from several runs is one decision, the first found, with the
 *  rest in `also`. */
export function decisions<T extends { thread: Thread }>(items: T[]): Decision<T>[] {
  const out: Decision<T>[] = [];
  const first = new Map<string, CardDecision<T>>();
  for (const d of items.flatMap(rowDecisions)) {
    const key = d.type === "card" ? topic(d.card) : null;
    const seen = key ? first.get(key) : undefined;
    if (seen) {
      seen.also.push(d.run);
      continue;
    }
    if (key && d.type === "card") first.set(key, d);
    out.push(d);
  }
  return out;
}
