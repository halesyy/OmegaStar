// The open conversations with where each stands, shared by the Inbox, its badge, the panel's chips and the
// conversation header: one read of the office, your marks, and a clock that ticks when a snooze ends.
import { useEffect, useMemo, useState } from "react";
import type { EmployeeView, OrgSnapshot, Thread } from "../../api/types";
import { threadTitle } from "../../lib/format";
import { refreshConversations, useConversations, useOrg } from "../../lib/hooks";
import { pruneMarks, seenSince, useMarks, type Marks } from "../../lib/marks";
import { nextWake, threadStatus, type Status, type StatusContext } from "../../lib/status";
import { kindNames } from "../RunRow";

/** A thread with what the Inbox and the chips show about it. `title` names it as the rest of the app does. */
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
