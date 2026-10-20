// A thread is a report and the replies you exchanged on it (`Thread { root, replies }`). A conversation you
// started is a thread too (a task under the hood), whose root is your first message, and an answer a colleague
// brought back into it is one of its replies. These helpers read one the same way everywhere: the Inbox and its
// Archive, the panel's chips, and the conversation screen.
import type { Card, Run, Thread } from "../api/types";

export const isLive = (r: Run): boolean => r.state === "running" || r.state === "queued";
export const didNotFinish = (r: Run): boolean => r.state === "failed" || r.state === "lost" || r.state === "cancelled";

/** When a thread last moved: its newest reply (sent or finished), else the report itself. */
export function activityAt(t: Thread): string {
  let at = t.root.endedAt ?? t.root.createdAt;
  for (const r of t.replies) {
    const x = r.endedAt ?? r.createdAt;
    if (x > at) at = x;
  }
  return at;
}

export const lastReply = (t: Thread): Run | undefined => t.replies[t.replies.length - 1];

/** The newest run that has finished: what the row says and what a reply box answers. */
export function latestFinished(t: Thread): Run {
  for (let i = t.replies.length - 1; i >= 0; i--) if (t.replies[i].endedAt) return t.replies[i];
  return t.root;
}

export const isTask = (t: Thread): boolean => t.root.kind.type === "task";

/** The employee is answering (a conversation's first message or a later turn is queued or running). */
export const threadBusy = (t: Thread): boolean => isLive(t.root) || t.replies.some(isLive);

/** Who spoke last: the employee once their newest reply finished, you while it is still on its way. A
 *  conversation's first message counts as a reply; a report does not. */
export function lastFrom(t: Thread): "you" | "them" | null {
  const l = lastReply(t) ?? (isTask(t) ? t.root : undefined);
  if (!l) return null;
  return l.endedAt ? "them" : "you";
}

/** An Inbox row's threads, oldest first: the one it leads with and the others filed with it. */
export const rowThreads = (t: Thread): Thread[] =>
  [t, ...t.related].sort((a, b) => a.root.createdAt.localeCompare(b.root.createdAt));

/** An Inbox row that is one schedule's failures in a row. */
export function isStreak(t: Thread): boolean {
  const k = t.root.kind;
  return k.type === "scheduled" && t.related.length > 0
    && t.related.every((x) => x.root.kind.type === "scheduled" && x.root.kind.scheduleId === k.scheduleId && didNotFinish(x.root));
}

/** An Inbox row that is a week of weekly reviews, everyone's in one row. A review waiting on a chore is filed
 *  in the chore's row instead. */
export function isTeamWeek(t: Thread): boolean {
  const k = t.root.kind;
  return k.type === "scheduled" && !!k.review && !choreOpen(t);
}

/** A card waiting on your answer: the run that asked it and its index in the run's `cards`. */
export type OpenCard = { run: Run; index: number; card: Card };

/** The cards in a thread waiting on your answer, newest run first. */
export const openCards = (t: Thread): OpenCard[] =>
  [...t.replies].reverse().concat(t.root).flatMap((run) => run.cards.flatMap((card, index) => (card.answer ? [] : [{ run, index, card }])));

/** Some thread in an Inbox row has a card waiting on you, so the row cannot be marked done yet. */
export const rowCardOpen = (t: Thread): boolean => rowThreads(t).some((x) => openCards(x).length > 0);

/** What a card is about, so the same question from anyone is one decision: its key, or for a chore asked
 *  before keys, `chore:<subject>`. Mirrors Rust `Card::topic`. */
export const topic = (c: Card): string | null => c.key ?? (c.ask.type === "chore" ? `chore:${c.ask.subject}` : null);

/** What needs you in a run that is not a card: flags Omega Star raised. Mirrors Rust `Run::flags`. */
export const flags = (r: Run): string[] => r.needsYou.filter((m) => !r.cards.some((c) => c.message === m));

/** Blocked on a tool you could allow (a tidy trying a command it may not run is not). */
export const blocked = (r: Run): boolean => r.denials.length > 0 && r.kind.type !== "tidy";

/** Broke for a reason you can act on: not the usage limit, which Omega Star waits out and retries itself. */
export const broken = (r: Run): boolean => (r.state === "failed" || r.state === "lost") && !r.limited;

/** A schedule's failures in a row before they need you. Mirrors Rust `threads::STREAK`. */
export const STREAK = 3;

/** Some run in an Inbox row has a chore waiting on you. */
const choreOpen = (t: Thread): boolean =>
  rowThreads(t).some((x) => openCards(x).some((c) => c.card.ask.type === "chore"));

/** An Inbox row that is everyone waiting on the same chore. */
export const isChoreRow = (t: Thread): boolean => t.related.length > 0 && choreOpen(t);

/** The conversation route's `focus` segment that selects a thread: `#/chat/<employee>/thread~<root run id>`. */
export const threadFocus = (rootId: string): string => `thread~${rootId}`;
export const parseThreadFocus = (focus: string | null): string | null =>
  focus && focus.startsWith("thread~") ? focus.slice("thread~".length) : null;
