import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { EmployeeView, NewAttachment, Run } from "../api/types";
import { firstName, threadTitle, whenInline } from "../lib/format";
import { refreshOrg, useOrg, useThread } from "../lib/hooks";
import { lastMoved, setMark, useMarkSeen } from "../lib/marks";
import { openChat, openFullChat, openMember, openRun, type Route } from "../lib/router";
import { threadStatus, type Status } from "../lib/status";
import { doneHeld, isLive, parseThreadFocus, rowThreads, startedByYou, threadFocus } from "../lib/threads";
import { kindNames } from "../components/RunRow";
import { Icon } from "../components/Icon";
import { Avatar, ErrorNote, Skeleton, StatePill } from "../components/ui";
import { NewConversation } from "../components/conversation/NewConversation";
import { ConversationChips } from "../components/conversation/ConversationChips";
import { DoneButton, markDone, reopen, sendAndDone, SnoozeButton, ThreadView } from "../components/conversation/ThreadView";
import { employeeItems, useStatuses, type Item } from "../components/conversation/useStatuses";
import "./Conversation.css";

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** Where a conversation shows: filling the main window, or on the employee's panel over the org chart. */
export type ConversationVariant = "full" | "panel";

/** The conversation filling the main window: one of an employee's threads, or a new one about to start. */
export function ConversationScreen({ route }: { route: Extract<Route, { page: "chat" }> }) {
  const { snap, error } = useOrg();
  if (!snap) {
    return <div className="convo convo-wait">{error ? <ErrorNote text={error} onRetry={refreshOrg} /> : <Skeleton h={44} r={10} />}</div>;
  }
  const e = snap.employees.find((x) => x.id === route.employeeId);
  if (!e) {
    return (
      <div className="convo empty">
        <Icon name="chat" size={22} />
        <span className="empty-title">They no longer work here</span>
        <p>Their conversations left with them. Their runs are still in Activity.</p>
      </div>
    );
  }
  return <Conversation e={e} focus={route.focus} variant="full" />;
}

/** The employee's conversation that `focus` names, the same in either variant: a thread (`thread~<root run id>`),
 *  or for anything else (null, or an old `new-task` link) a new conversation. */
export function Conversation({ e, focus, variant }: { e: EmployeeView; focus: string | null; variant: ConversationVariant }) {
  const rootId = parseThreadFocus(focus);
  if (rootId) return <ThreadConversation key={rootId} e={e} rootId={rootId} variant={variant} />;
  return <StartConversation key={e.id} e={e} variant={variant} />;
}

/** The thread or conversation with `rootId`: its header actions, and E to mark it done. */
function ThreadConversation({ e, rootId, variant }: { e: EmployeeView; rootId: string; variant: ConversationVariant }) {
  const { snap } = useOrg();
  const thread = useThread(rootId);
  const { items, filed, ctx } = useStatuses();
  const leave = useLeave(e.id, rootId, items);
  const runs = thread.turns?.map((t) => t.run) ?? [];
  useMarkSeen(rootId, lastMoved(runs));
  const root = runs[0] ?? null;
  const task = !!root && startedByYou(root);
  const archived = !!root?.archivedAt;
  const name = firstName(e.name);
  // The Inbox row the conversation is in, whether it leads the row or is filed under another.
  const inRow = items?.find((i) => rowThreads(i.thread).some((x) => x.root.id === rootId)) ?? null;
  const row = inRow?.thread.root.id === rootId ? inRow : null;
  const status = root ? threadStatus({ root, replies: runs.slice(1), related: [] }, !!filed?.has(rootId), ctx) : null;
  const title = root ? threadTitle(root, kindNames(root, snap?.employees ?? [], snap?.people ?? [])) : row?.title ?? "";

  const done = async () => {
    const go = leave();
    if (await markDone(rootId)) go();
  };
  const sendDone = async (text: string, attachments: NewAttachment[]) => {
    const go = leave();
    await sendAndDone(rootId, name, text, attachments);
    go();
  };
  const snooze = (until: Date) => {
    const go = leave();
    setMark(rootId, { snoozedUntil: until.toISOString() });
    go();
  };

  const doneRef = useRef(done);
  doneRef.current = done;
  const ready = !!root?.endedAt && !archived && !runs.some(isLive);
  // A card waiting on you is answered on the card, so neither Done nor E closes the thread.
  const own = root ? { root, replies: runs.slice(1), related: [] } : null;
  const carded = own ? doneHeld(own, inRow?.thread ?? own) : false;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || typing(ev.target) || document.querySelector(".popover")) return;
      if (ev.key.toLowerCase() !== "e" || !ready || carded) return;
      ev.preventDefault();
      void doneRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, carded]);

  const actions = root ? (
    <>
      {archived ? null : <SnoozeButton snoozedUntil={status?.snoozedUntil ?? null} onSnooze={snooze} onWake={() => setMark(rootId, { snoozedUntil: undefined })} />}
      {task ? null : <button className="btn btn-ghost btn-sm" onClick={() => openRun(root.id)}>Open run <Icon name="arrowUpRight" size={12} /></button>}
      {archived
        ? <button className="btn btn-sm" onClick={() => void reopen(rootId)}><Icon name="undo" size={13} /> Reopen</button>
        : carded ? null : <DoneButton name={name} disabled={!ready} onDone={done} />}
    </>
  ) : null;
  return (
    <ConversationFrame e={e} variant={variant} focus={threadFocus(rootId)} title={title} root={root} status={<StatusPill status={status} />} actions={actions}>
      <ThreadView e={e} rootId={rootId} thread={thread} row={row?.thread ?? null} onSendDone={archived ? null : sendDone} />
    </ConversationFrame>
  );
}

/** A conversation before its first message. */
function StartConversation({ e, variant }: { e: EmployeeView; variant: ConversationVariant }) {
  return (
    <ConversationFrame e={e} variant={variant} focus={null} title="New conversation" status={null}>
      <NewConversation e={e} />
    </ConversationFrame>
  );
}

/** What every conversation has around it: one header saying what it is, where it stands and what you can do with
 *  it, and a button to the other variant. Full window, the header also says who it is with; on the panel, which
 *  already does, the employee's other conversations sit above it as chips. */
function ConversationFrame({ e, variant, focus, title, root = null, status, actions, children }: {
  e: EmployeeView;
  variant: ConversationVariant;
  /** The conversation, as the route names it. */
  focus: string | null;
  title: string;
  /** A thread's root run, once loaded, for its chip when it is not open any more. */
  root?: Run | null;
  status: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const panel = variant === "panel";
  return (
    <div className={`convo ${panel ? "convo-panel" : ""}`}>
      {panel ? <ConversationChips e={e} focus={focus} title={title} root={root} /> : null}
      <header className="convo-head">
        {panel ? <h3 className="convo-title" title={title}>{title}</h3> : (
          <>
            <Avatar name={e.name} hue={e.hue} size={32} presence={e.presence} />
            <div className="convo-id">
              <h1 className="convo-title" title={title}>{title}</h1>
              <button className="convo-sub" onClick={() => openMember(e.id, "work")} title={`Open ${firstName(e.name)}'s work`}>{e.name}, {e.title}</button>
            </div>
          </>
        )}
        {status}
        <span className="grow" />
        <div className="convo-actions">
          {actions}
          {panel ? (
            <button className="btn btn-ghost btn-icon btn-sm" aria-label="Open full window" title="Open full window" onClick={() => openFullChat(e.id, focus)}>
              <Icon name="expand" size={14} />
            </button>
          ) : (
            <button className="btn btn-ghost btn-icon btn-sm" aria-label="Show on the org chart" title="Show on the org chart" onClick={() => openMember(e.id, "chat", focus)}>
              <Icon name="org" size={14} />
            </button>
          )}
        </div>
      </header>
      {children}
    </div>
  );
}

/** Where the conversation stands, as a pill; nothing while it is idle. */
function StatusPill({ status }: { status: Status | null }) {
  switch (status?.state) {
    case "needsYou": return <StatePill tone="warn">Needs you</StatePill>;
    case "working": return <StatePill tone="accent" pulse>Working</StatePill>;
    case "queued": return <StatePill tone="accent">Queued</StatePill>;
    case "snoozed": return <StatePill tone="neutral">Snoozed until {whenInline(status.snoozedUntil)}</StatePill>;
    case "done": return <StatePill tone="ok">Done</StatePill>;
    default: return null;
  }
}

/** Leaving the thread after you snooze it or mark it done: call before acting, to fix the employee's next thread
 *  while this one is still among `items`, then call what it returns to open it (a new conversation when none is left). */
function useLeave(employeeId: string, rootId: string, items: Item[] | null): () => () => void {
  const latest = useRef(items);
  latest.current = items;
  return useCallback(() => {
    const mine = employeeItems(latest.current ?? [], employeeId);
    const i = mine.findIndex((x) => x.thread.root.id === rootId);
    const next = i < 0 ? null : mine[i + 1] ?? mine[i - 1] ?? null;
    return () => openChat(employeeId, next ? threadFocus(next.thread.root.id) : null, true);
  }, [employeeId, rootId]);
}
