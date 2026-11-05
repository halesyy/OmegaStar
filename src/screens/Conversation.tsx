import { useEffect, useRef, type ReactNode } from "react";
import type { EmployeeView, NewAttachment } from "../api/types";
import { firstName } from "../lib/format";
import { refreshOrg, useOrg, useThread } from "../lib/hooks";
import { lastMoved, useMarkSeen } from "../lib/marks";
import { openMember, type Route } from "../lib/router";
import { parseThreadFocus, threadFocus } from "../lib/threads";
import { Icon } from "../components/Icon";
import { Avatar, ErrorNote, Skeleton } from "../components/ui";
import { NewConversation } from "../components/conversation/NewConversation";
import { ConversationActions, StateWord, useArchive, useLeave, useThreadState } from "../components/conversation/ConversationSwitcher";
import { sendAndDone, ThreadSkeleton, ThreadView } from "../components/conversation/ThreadView";
import "./Conversation.css";

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** Where a conversation shows: filling the main window, or on the employee's panel over the org chart. */
export type ConversationVariant = "full" | "panel";

/** The conversation filling the main window: one of an employee's threads, or a new one about to start. */
export function ConversationScreen({ route }: { route: Extract<Route, { page: "chat" }> }) {
  const { snap, error } = useOrg();
  if (!snap) {
    return error ? (
      <div className="convo"><div className="thread-error"><ErrorNote title="Couldn't open this conversation" text={error} onRetry={refreshOrg} /></div></div>
    ) : (
      <div className="convo" aria-busy="true">
        <header className="convo-head">
          <div className="convo-id">
            <Skeleton h={26} w={320} r={4} />
            <div className="convo-sub"><Skeleton h={20} w={20} r={10} /><Skeleton h={12} w={180} /></div>
          </div>
        </header>
        <ThreadSkeleton />
      </div>
    );
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
 *  or for anything else (null, or an old `new-task` link) a new conversation. On a person's panel the conversation
 *  brings no header of its own: the panel's tab row holds `ConversationSwitcher` (its name, its state and its actions). */
export function Conversation({ e, focus, variant }: { e: EmployeeView; focus: string | null; variant: ConversationVariant }) {
  const rootId = parseThreadFocus(focus);
  if (rootId) return <ThreadConversation key={rootId} e={e} rootId={rootId} variant={variant} />;
  return (
    <ConversationFrame e={e} variant={variant} focus={null} title="New conversation" state={null}>
      <NewConversation key={e.id} e={e} compact={variant === "panel"} />
    </ConversationFrame>
  );
}

/** The thread or conversation with `rootId`: its header, its actions, and E to archive it. */
function ThreadConversation({ e, rootId, variant }: { e: EmployeeView; rootId: string; variant: ConversationVariant }) {
  const thread = useThread(rootId);
  const s = useThreadState(rootId);
  const runs = thread.turns?.map((t) => t.run) ?? s.runs;
  useMarkSeen(rootId, lastMoved(runs));
  const name = firstName(e.name);
  const leave = useLeave(e.id, rootId);
  const archive = useArchive(e.id, rootId);
  const sendDone = async (text: string, attachments: NewAttachment[]) => {
    const go = leave();
    await sendAndDone(rootId, name, text, attachments);
    go();
  };

  const archiveRef = useRef(archive);
  archiveRef.current = archive;
  const { ready, carded } = s;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || typing(ev.target) || document.querySelector(".popover")) return;
      if (ev.key.toLowerCase() !== "e" || !ready || carded) return;
      ev.preventDefault();
      void archiveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, carded]);

  return (
    <ConversationFrame e={e} variant={variant} focus={threadFocus(rootId)} title={s.title} state={<StateWord s={s} sep />} actions={<ConversationActions e={e} rootId={rootId} s={s} />}>
      <ThreadView e={e} rootId={rootId} thread={thread} row={s.row?.thread ?? null} onSendDone={s.archived ? null : sendDone} />
    </ConversationFrame>
  );
}

/** What a conversation has around it in the full window: one header saying what it is (in Display), who it is with
 *  and where it stands in a word, then what you can do with it and a way to the org chart. On a panel, nothing: the
 *  panel's own head and tab row say who and which. */
function ConversationFrame({ e, variant, focus, title, state, actions, children }: {
  e: EmployeeView;
  variant: ConversationVariant;
  /** The conversation, as the route names it. */
  focus: string | null;
  title: string;
  state: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  if (variant === "panel") return <div className="convo convo-panel">{children}</div>;
  return (
    <div className="convo">
      <header className="convo-head">
        <div className="convo-id">
          <h1 className="convo-title" title={title}>{title}</h1>
          <div className="convo-sub">
            <Avatar name={e.name} hue={e.hue} size={20} />
            <button className="convo-who" onClick={() => openMember(e.id, "work")} data-tip={`Open ${firstName(e.name)}'s work`}>{e.name}, {e.title}</button>
            {state}
          </div>
        </div>
        <div className="convo-actions">
          {actions}
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Show on the org chart" data-tip="Show on the org chart" onClick={() => openMember(e.id, "chat", focus)}>
            <Icon name="org" size={15} />
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}
