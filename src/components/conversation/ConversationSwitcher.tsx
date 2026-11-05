import { useCallback, useRef, useState } from "react";
import { call } from "../../api/client";
import type { EmployeeView, Run, Thread } from "../../api/types";
import { firstName, threadTitle, whenInline } from "../../lib/format";
import { useNow, useOrg, useQuery } from "../../lib/hooks";
import { setMark } from "../../lib/marks";
import { openChat, openFullChat, openRun } from "../../lib/router";
import { threadStatus, type Status } from "../../lib/status";
import { didNotFinish, doneHeld, isLive, parseThreadFocus, rowThreads, startedByYou, threadFocus } from "../../lib/threads";
import { kindIcon, kindNames } from "../RunRow";
import { Icon } from "../Icon";
import { Popover, Roll } from "../ui";
import { DoneButton, markDone, reopen, SnoozeButton } from "./ThreadView";
import { employeeItems, useStatuses, type Item } from "./useStatuses";
import { minutes } from "./work";

/** Where a conversation stands, for its header and its actions: its runs, its state, and whether it can be archived. */
export type ThreadState = {
  root: Run | null; runs: Run[]; title: string; status: Status | null; archived: boolean; task: boolean;
  /** It finished and nothing is running, so Archive can file it. */
  ready: boolean;
  /** A card waits on you: it is answered on the card, so neither Archive nor E closes it. */
  carded: boolean;
  /** The Inbox row it is in, when it leads one. */
  row: Item | null;
  failed: boolean;
};

/** The thread with `rootId` as its header and actions need it: read on its own (light, no transcripts), so the switcher
 *  works wherever it is placed. */
export function useThreadState(rootId: string | null): ThreadState {
  const { snap } = useOrg();
  const { items, filed, ctx } = useStatuses();
  const q = useQuery<Thread | null>(() => (rootId ? call("thread", { runId: rootId }) : Promise.resolve(null)), [rootId], ["run:updated"]);
  const t = q.data ?? null;
  const root = t?.root ?? null;
  const runs = t ? [t.root, ...t.replies] : [];
  const inRow = rootId ? items?.find((i) => rowThreads(i.thread).some((x) => x.root.id === rootId)) ?? null : null;
  const row = inRow?.thread.root.id === rootId ? inRow : null;
  const own = root ? { root, replies: runs.slice(1), related: [] } : null;
  const status = own ? threadStatus(own, !!(rootId && filed?.has(rootId)), ctx) : row?.status ?? null;
  const tail = runs[runs.length - 1];
  return {
    root, runs, status, row,
    title: root ? threadTitle(root, kindNames(root, snap?.employees ?? [], snap?.people ?? [])) : row?.title ?? "",
    archived: !!root?.archivedAt,
    task: !!root && startedByYou(root),
    ready: !!root?.endedAt && !root.archivedAt && !runs.some(isLive),
    carded: own ? doneHeld(own, inRow?.thread ?? own) : false,
    failed: !!tail && didNotFinish(tail) && !runs.some(isLive),
  };
}

/** Leaving the thread after you snooze it or archive it: call before acting, to fix the employee's next thread while this
 *  one is still among the items, then call what it returns to open it (a new conversation when none is left). */
export function useLeave(employeeId: string, rootId: string): () => () => void {
  const { items } = useStatuses();
  const latest = useRef(items);
  latest.current = items;
  return useCallback(() => {
    const mine = employeeItems(latest.current ?? [], employeeId);
    const i = mine.findIndex((x) => x.thread.root.id === rootId);
    const next = i < 0 ? null : mine[i + 1] ?? mine[i - 1] ?? null;
    return () => openChat(employeeId, next ? threadFocus(next.thread.root.id) : null, true);
  }, [employeeId, rootId]);
}

/** Archive the thread with `rootId` and move to the employee's next one. */
export function useArchive(employeeId: string, rootId: string) {
  const leave = useLeave(employeeId, rootId);
  return useCallback(async () => {
    const go = leave();
    if (await markDone(rootId)) go();
  }, [leave, rootId]);
}

/** The state of a conversation in one word with its colour: "Working 3 min", "Up next", "Needs you", "Failed", "Snoozed
 *  until tomorrow 9:00 am", "Done". Nothing while it is idle. */
export function StateWord({ s, sep = false }: { s: ThreadState; sep?: boolean }) {
  const liveRun = s.runs.find((r) => r.state === "running");
  const now = useNow(30_000, !!liveRun);
  const st = s.status?.state;
  const word = st === "working" || liveRun ? <span className="status status-live">Working{liveRun?.startedAt ? <span className="status-n num"><Roll value={minutes(now - Date.parse(liveRun.startedAt))} /></span> : null}</span>
    : st === "queued" ? <span className="status status-wait">Up next</span>
    : st === "needsYou" ? <span className="status status-attn">{s.failed ? "Failed" : "Needs you"}</span>
    : st === "snoozed" ? <span className="status status-plain">Snoozed until {whenInline(s.status!.snoozedUntil)}</span>
    : st === "done" || s.archived ? <span className="status status-ok">Done</span>
    : null;
  if (!word) return null;
  return sep ? <><span className="convo-sep" aria-hidden>·</span>{word}</> : word;
}

/**
 * What you can do with a conversation: Later (or Wake now), Open run for a report, Archive with E (or Reopen once
 * archived). `icons` draws them as small icon buttons with tooltips, for the switcher in a person's panel.
 */
export function ConversationActions({ e, rootId, s, icons = false }: { e: EmployeeView; rootId: string; s: ThreadState; icons?: boolean }) {
  const name = firstName(e.name);
  const leave = useLeave(e.id, rootId);
  const archive = useArchive(e.id, rootId);
  if (!s.root) return null;
  const snooze = (until: Date) => {
    const go = leave();
    setMark(rootId, { snoozedUntil: until.toISOString() });
    go();
  };
  const wake = () => setMark(rootId, { snoozedUntil: undefined });
  // One rule: Archive shows once nothing in the thread needs you (E still files it when nothing holds it).
  const needs = s.status?.state === "needsYou";
  if (icons) {
    return (
      <>
        {s.archived ? null : <SnoozeButton snoozedUntil={s.status?.snoozedUntil ?? null} onSnooze={snooze} onWake={wake} icon />}
        {s.archived ? (
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Reopen" data-tip="Reopen" onClick={() => void reopen(rootId)}><Icon name="undo" size={14} /></button>
        ) : s.carded || !s.ready || needs ? null : (
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Archive" data-tip="Archive (E)" onClick={() => void archive()}><Icon name="archive" size={14} /></button>
        )}
      </>
    );
  }
  return (
    <>
      {s.archived ? null : <SnoozeButton snoozedUntil={s.status?.snoozedUntil ?? null} onSnooze={snooze} onWake={wake} />}
      {s.task ? null : <button className="btn btn-ghost btn-sm" onClick={() => openRun(s.root!.id)}>Open run <Icon name="arrowUpRight" size={12} /></button>}
      {s.archived
        ? <button className="btn btn-ghost btn-sm" onClick={() => void reopen(rootId)}><Icon name="undo" size={13} /> Reopen</button>
        : s.carded || !s.ready || needs ? null : <DoneButton name={name} disabled={false} onDone={archive} ghost />}
    </>
  );
}

/** A dot for where a conversation stands, as the menu lists it. */
const DOT: Partial<Record<Status["state"], string>> = { needsYou: "dot dot-attn", working: "dot dot-live", queued: "dot dot-wait" };
const WORD: Partial<Record<Status["state"], string>> = { needsYou: "Needs you", working: "Working", queued: "Up next", snoozed: "Later" };

/**
 * The person panel's conversation switcher, for the right end of its tab row: the open conversation's name and its state,
 * a menu of the employee's open conversations (each with its state) and New conversation, then the open thread's own
 * actions (Later, Archive with E, or Reopen) and Open full window. `focus` is the open conversation as the route names
 * it (`thread~<root run id>`), or null for a new one.
 */
export function ConversationSwitcher({ e, focus }: { e: EmployeeView; focus: string | null }) {
  const rootId = parseThreadFocus(focus);
  const s = useThreadState(rootId);
  const { items } = useStatuses();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const mine = employeeItems(items ?? [], e.id);
  const list: { focus: string; title: string; icon: ReturnType<typeof kindIcon>; status: Status | null }[] = mine.map((i) => ({ focus: threadFocus(i.thread.root.id), title: i.title, icon: kindIcon(i.thread.root), status: i.status }));
  if (rootId && s.root && !list.some((x) => x.focus === focus)) list.unshift({ focus: threadFocus(rootId), title: s.title, icon: s.root.archivedAt ? "archive" : kindIcon(s.root), status: null });
  const title = rootId ? s.title || "Conversation" : "New conversation";
  const dot = s.status ? DOT[s.status.state] : undefined;
  const go = (f: string | null) => { setOpen(false); openChat(e.id, f, true); };
  return (
    <div className="convo-switch">
      <button ref={anchor} type="button" className="convo-pick" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="chat" size={14} />
        <span className="trunc">{title}</span>
        {dot ? <span className={dot} aria-label={WORD[s.status!.state]} /> : null}
        <Icon name="chevronDown" size={14} className="convo-pick-chev" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={300}>
        <div className="menu convo-menu" role="menu" aria-label={`Conversations with ${firstName(e.name)}`}>
          {list.map((x) => {
            const word = x.status ? WORD[x.status.state] : undefined;
            return (
              <button key={x.focus} type="button" role="menuitemradio" aria-checked={x.focus === focus} className="menu-item" onClick={() => go(x.focus)}>
                <Icon name={x.icon} size={14} />
                <span className="grow trunc">{x.title}</span>
                {word ? <span className={`convo-menu-state ${x.status!.state === "needsYou" ? "status-attn" : x.status!.state === "working" ? "status-live" : ""}`}>{word}</span> : null}
              </button>
            );
          })}
          {list.length ? <div className="menu-sep" /> : null}
          <button type="button" role="menuitemradio" aria-checked={focus === null} className="menu-item" onClick={() => go(null)}>
            <Icon name="plus" size={14} /><span className="grow">New conversation</span>
          </button>
        </div>
      </Popover>
      {rootId ? <ConversationActions e={e} rootId={rootId} s={s} icons /> : null}
      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Open full window" data-tip="Open full window" onClick={() => openFullChat(e.id, focus)}>
        <Icon name="expand" size={14} />
      </button>
    </div>
  );
}
