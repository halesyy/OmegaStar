// The open conversations with where each stands, shared by the Inbox, its badge and the conversation header: one
// read of the office, your marks, and a clock that ticks when a snooze ends.
import { useEffect, useMemo, useState } from "react";
import { call, subscribe } from "../../api/client";
import type { EmployeeView, OrgSnapshot, PersonView, Run, Thread } from "../../api/types";
import { threadTitle } from "../../lib/format";
import { refreshConversations, useConversations, useOrg } from "../../lib/hooks";
import { pruneMarks, seenSince, useMarks, type Marks } from "../../lib/marks";
import { nextWake, threadStatus, type Status, type StatusContext } from "../../lib/status";
import { conversationOf, isLive, latestFinished, threadBusy, threadFocus } from "../../lib/threads";
import { kindNames, workTitle } from "../../lib/workTitle";

/** A thread with what the Inbox and the conversation header show about it. `title` names it as the rest of the app
 *  does. */
export type Item = { thread: Thread; employee: EmployeeView; title: string; status: Status };

/** A thread as an item, or null when its employee no longer works here. `filed`: it leads an Inbox row. */
export function toItem(thread: Thread, snap: OrgSnapshot, filed: boolean, ctx: StatusContext): Item | null {
  const employee = snap.employees.find((e) => e.id === thread.root.employeeId);
  if (!employee) return null;
  const title = threadTitle(thread.root, kindNames(thread.root, snap.employees, snap.people));
  return { thread, employee, title, status: threadStatus(thread, filed, ctx) };
}

/** One employee's open threads, newest first, so each keeps its place as the others move. */
export const employeeItems = (items: Item[], employeeId: string): Item[] =>
  items.filter((i) => i.employee.id === employeeId).sort((a, b) => b.thread.root.createdAt.localeCompare(a.thread.root.createdAt));

/**
 * Which conversation opening an employee lands on, so it arrives on what matters: when their last run needs you, the
 * thread that holds it; else the first of their live work that is a conversation; else a thread of theirs that needs
 * you; else the newest of their open conversations; else null, a new conversation. `items` is null while the office's
 * conversations load.
 */
export function conversationFor(e: EmployeeView, items: Item[] | null): string | null {
  const mine = items ? employeeItems(items, e.id) : [];
  const waiting = mine.filter((i) => i.status.state === "needsYou");
  const last = e.lastRun;
  if (e.presence === "attention" && last) {
    const holds = waiting.find((i) => [i.thread.root, ...i.thread.replies, ...i.thread.related.map((t) => t.root)].some((r) => r.id === last.id));
    const root = holds?.thread.root.id ?? conversationOf(last) ?? waiting[0]?.thread.root.id;
    if (root) return threadFocus(root);
  }
  const live = e.live.map(conversationOf).find((r) => r !== null);
  if (live) return threadFocus(live);
  const first = waiting[0] ?? mine[0];
  return first ? threadFocus(first.thread.root.id) : null;
}

/** How far back an employee's closed conversations still show in their header's menu and on their page. */
const RECENT_MS = 3 * 24 * 3_600_000;
/** Most conversations those lists hold beyond the open ones. */
const RECENT_CAP = 12;
/** Runs that start a conversation worth finding again once it is closed: one you started or ran by hand, and work a
 *  colleague handed over. A routine's report or OmegaStar's own check counts only once someone replied in it. */
const STARTS: Run["kind"]["type"][] = ["task", "chat", "manual", "asked", "delegated"];

/** A conversation to switch to: its first run's id (`root` when it was read), its name, where it stands when it is
 *  open, whether work in it is going on, the first line of its latest report, and when it started. */
export type Chat = { rootId: string; root: Run | null; title: string; status: Status | null; live: boolean; line: string; at: string };

/** A conversation's name, as its header and the lists of conversations show it. A run you started by hand is named by
 *  what you asked, not "Manual run", so the lists can be scanned. */
export function chatTitle(root: Run, employees: EmployeeView[], people: PersonView[]): string {
  return root.kind.type === "manual" ? workTitle(root, employees, people) : threadTitle(root, kindNames(root, employees, people));
}

/** The first line of a report, without its markdown. */
const reportLine = (r: Run | undefined) => r?.summary?.replace(/[*_`#>|]/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** An employee's runs from the last three days, newest first. Read once by time, so a day of busy routines does not
 *  push yesterday's conversations out, then kept current from `run:updated` rather than read again on every update. */
function useRecentRuns(employeeId: string): Run[] | null {
  const [read, setRead] = useState<{ employeeId: string; runs: Run[] } | null>(null);
  useEffect(() => {
    let gone = false;
    const off = subscribe("run:updated", (r) => {
      if (r.employeeId !== employeeId) return;
      setRead((was) => {
        if (was?.employeeId !== employeeId) return was;
        const known = was.runs.some((x) => x.id === r.id);
        return { employeeId, runs: known ? was.runs.map((x) => (x.id === r.id ? r : x)) : [r, ...was.runs] };
      });
    });
    const since = new Date(Date.now() - RECENT_MS).toISOString();
    call("runs_since", { employeeId, since }).then(
      (runs) => { if (!gone) setRead({ employeeId, runs }); },
      () => { if (!gone) setRead({ employeeId, runs: [] }); },
    );
    return () => { gone = true; off(); };
  }, [employeeId]);
  return read?.employeeId === employeeId ? read.runs : null;
}

/**
 * One employee's conversations to switch between, latest started first: every open one, then any other they had in the last
 * three days (a hand-off, a run you started, one you archived), each once. The open ones show while the rest load;
 * null until the office's conversations have.
 */
export function useRecentChats(e: EmployeeView): Chat[] | null {
  const { items } = useStatuses();
  const { snap } = useOrg();
  const recent = useRecentRuns(e.id);
  return useMemo(() => {
    if (!items || !snap) return null;
    const name = (root: Run) => chatTitle(root, snap.employees, snap.people);
    const open: Chat[] = employeeItems(items, e.id).map((i) => ({
      rootId: i.thread.root.id, root: i.thread.root, title: name(i.thread.root), status: i.status, live: threadBusy(i.thread),
      line: reportLine(latestFinished(i.thread)), at: i.thread.root.createdAt,
    }));
    const seen = new Set(open.map((c) => c.rootId));
    const runs = recent ?? [];
    const byId = new Map(runs.map((r) => [r.id, r]));
    const turnsOf = new Map<string, Run[]>();
    for (const r of runs) {
      const rootId = conversationOf(r) ?? r.id;
      turnsOf.set(rootId, [...(turnsOf.get(rootId) ?? []), r]);
    }
    const more: Chat[] = [];
    // Runs come newest first, so a conversation's first run here is its latest.
    for (const r of runs) {
      if (more.length >= RECENT_CAP) break;
      const rootId = conversationOf(r) ?? r.id;
      if (seen.has(rootId)) continue;
      const root = byId.get(rootId) ?? null;
      if (rootId === r.id ? !STARTS.includes(r.kind.type) : !root && r.kind.type !== "reply") continue;
      seen.add(rootId);
      const title = root ? name(root) : r.kind.type === "reply" ? r.kind.label : "";
      const turns = turnsOf.get(rootId) ?? [];
      more.push({ rootId, root, title, status: null, live: turns.some(isLive), line: reportLine(turns.find((x) => x.summary)), at: root?.createdAt ?? r.createdAt });
    }
    return [...open, ...more].sort((a, b) => b.at.localeCompare(a.at));
  }, [items, snap, recent, e.id]);
}

/** Now, kept current at the next snooze's end. */
function useWakeClock(marks: Marks): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const cur = Date.now();
    const at = nextWake(marks, cur);
    if (at === null) return;
    const h = window.setTimeout(() => setNow(Date.now()), at - cur + 50);
    return () => window.clearTimeout(h);
  }, [marks, now]);
  return now;
}

/** Every open thread as an item (null while loading), the context a status is read in, for a conversation the
 *  snapshot does not have, and `reload` for Try again. */
export function useStatuses() {
  const { data, error } = useConversations();
  const { snap } = useOrg();
  const marks = useMarks();
  const now = useWakeClock(marks);
  const [since] = useState(seenSince);
  const ctx = useMemo<StatusContext>(() => ({ marks, since, now }), [marks, since, now]);
  const read = useMemo(() => {
    if (!data || !snap) return null;
    const filed = new Set(data.inbox);
    const items = data.threads.flatMap((t) => toItem(t, snap, filed.has(t.root.id), ctx) ?? []);
    return { items, filed };
  }, [data, snap, ctx]);
  return { items: read?.items ?? null, filed: read?.filed ?? null, ctx, error, reload: refreshConversations };
}

/** Forgets the marks of conversations that are no longer open. The shell runs this once. */
export function usePruneMarks() {
  const { data } = useConversations();
  useEffect(() => {
    if (!data) return;
    pruneMarks(new Set(data.threads.map((t) => t.root.id)));
  }, [data]);
}
