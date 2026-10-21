// The Inbox as decisions: one entry per thing waiting on you, read from the rows the Inbox shows. The questions a
// run asks are one entry, since it hears your answers together. A question several employees asked is one entry,
// and answering it answers them all. Pure.
import type { Run, Thread } from "../api/types";
import { blockedNow, broken, flags, latestFinished, rowThreads, STREAK, topic, type OpenCard } from "./threads";

/** Something waiting on you in a row (`item`). `thread`: the row's thread it is in; `run`: the run it is about. */
export type Decision<T> = { id: string; item: T; thread: Thread; run: Run } & (
  | { type: "card"; cards: OpenCard[]; also: Run[] }          // cards: the run's, open or held; also: other runs asking the same
  | { type: "flag"; text: string }                            // something Omega Star flagged
  | { type: "blocked" }                                        // blocked on a tool you could allow
  | { type: "broken"; times: number }                          // broke; times: a schedule's failures in a row
  | { type: "answered" }                                       // the employee answered you
);

type CardDecision<T> = Extract<Decision<T>, { type: "card" }>;

const scheduled = (x: Thread): boolean => x.root.kind.type === "scheduled";

/** A run's cards its employee has yet to hear about: open, or answered and held back until the rest are. */
const unsent = (run: Run): OpenCard[] =>
  run.cards.flatMap((card, index) => (!card.answer || card.answer.held ? [{ run, index, card }] : []));

/** What a row waits on you for, newest first. Mirrors Rust `threads::needs_you`: cards anywhere, and what each
 *  thread's newest finished run flagged, was blocked on or broke; a schedule's failures count once `STREAK` of them
 *  are in a row, as one decision. A row that asks nothing is the employee answering you. */
function rowDecisions<T extends { thread: Thread }>(item: T): Decision<T>[] {
  const all = rowThreads(item.thread);
  const open = all.filter((x) => !x.root.archivedAt).reverse();
  const out: Decision<T>[] = [];
  for (const x of open) {
    for (const run of [...x.replies].reverse().concat(x.root)) {
      const cards = unsent(run);
      if (cards.some((c) => !c.card.answer)) out.push({ type: "card", id: `${run.id}:cards`, item, thread: x, run, cards, also: [] });
    }
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

/** Every decision in `items`, in their order. A lone question also in another decision joins it, the first with it,
 *  as `also`; a run's several questions stay together. */
export function decisions<T extends { thread: Thread }>(items: T[]): Decision<T>[] {
  const all = items.flatMap(rowDecisions);
  const first = new Map<string, CardDecision<T>>();
  const claim = (d: CardDecision<T>) => {
    for (const c of d.cards) {
      const key = c.card.answer ? null : topic(c.card);
      if (key && !first.has(key)) first.set(key, d);
    }
  };
  for (const d of all) if (d.type === "card" && d.cards.length > 1) claim(d);
  const out: Decision<T>[] = [];
  for (const d of all) {
    if (d.type === "card" && d.cards.length === 1) {
      const key = topic(d.cards[0].card);
      const seen = key ? first.get(key) : undefined;
      if (seen) {
        seen.also.push(d.run);
        continue;
      }
      claim(d);
    }
    out.push(d);
  }
  return out;
}
