import { useRef, useState } from "react";
import { call, errorMessage } from "../../api/client";
import type { EmployeeView, NewAttachment, Run, RunEvent, Thread } from "../../api/types";
import { dateLong, firstName, relTime, whenShort } from "../../lib/format";
import { dropConversation, refreshConversations, useOrg, type Conversation } from "../../lib/hooks";
import { snoozePresets } from "../../lib/status";
import { toast } from "../../lib/toasts";
import { didNotFinish, flags, isLive, startedByYou } from "../../lib/threads";
import { RunCards } from "./CardView";
import { RowHistory } from "./RowHistory";
import { BlockedCard } from "../BlockedCard";
import { TidyProposal } from "../TidyProposal";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";
import { Visual } from "../Visual";
import { Avatar, ErrorNote, Popover, Skeleton, SkillsGrew } from "../ui";
import { ChatSurface, type ChatSurfaceHandle } from "../panel/ChatSurface";
import { Turn } from "../panel/ChatTurn";
import "../panel/ChatTab.css";
import "../../screens/Inbox.css";

const TEACH_PREFIX = "I want to teach you a new task: ";

/**
 * A thread on one of the employee's reports, or a conversation you started, read as a conversation: the report
 * (or your first message) first, then each reply (and each answer a colleague brought back into it) as a turn, with
 * a composer that answers in it. What you send while the
 * employee works reaches them as they work, or runs as the next reply. Whoever shows it (the conversation
 * screen, an Inbox row) holds the thread's runs (`thread`), and the rest of an Inbox row (`row`) when it leads one.
 * With `recent` it opens on the latest exchange, and the turns before it wait behind "Show N earlier".
 */
export function ThreadView({ e, rootId, thread, row, onSendDone, autoFocus = true, recent = false }: {
  e: EmployeeView;
  rootId: string;
  thread: Conversation;
  /** The thread as the Inbox has it, with the other threads filed under its row in `related`. */
  row: Thread | null;
  /** "Send & done": the reply goes, and the thread comes back only if the answer needs you. Null when done already. */
  onSendDone: ((text: string, attachments: NewAttachment[]) => Promise<void>) | null;
  /** The composer takes focus when the thread appears. */
  autoFocus?: boolean;
  /** Show only the latest exchange until you ask for the rest. */
  recent?: boolean;
}) {
  const { snap } = useOrg();
  const { turns, error, reload, appendRun } = thread;
  const surface = useRef<ChatSurfaceHandle>(null);
  const [all, setAll] = useState(false);
  const root = turns?.[0]?.run;
  const replies = turns?.slice(1) ?? [];
  const live = turns?.find((t) => t.run.state === "running") ?? turns?.find((t) => isLive(t.run));
  const archived = !!root?.archivedAt;
  const task = !!root && startedByYou(root);
  const name = firstName(e.name);

  const liveKey = turns ? `${turns.length}:${turns[turns.length - 1]?.events.length}:${turns[turns.length - 1]?.live.length}` : "";

  const send = async (text: string, attachments: NewAttachment[]) => {
    const run = await call("reply_to_run", { runId: rootId, text, archive: false, attachments });
    appendRun(run);
  };
  const stop = async () => {
    if (!live) return;
    try { await call("cancel_run", { runId: live.run.id }); } catch (err) { toast(errorMessage(err), "err"); }
  };

  if (error) return <div style={{ padding: 20 }}><ErrorNote text={error} onRetry={reload} /></div>;
  if (!turns || !root) {
    return (
      <div className="thread">
        <div className="chat-inner">
          <Skeleton h={44} r={10} />
          <div className="stack" style={{ gap: 8 }}><Skeleton w="90%" /><Skeleton w="75%" /><Skeleton w="40%" /></div>
        </div>
      </div>
    );
  }

  const tail = replies.length ? replies[replies.length - 1].run : root;
  const place = task ? "conversation" : "thread";
  const hint = archived ? (task ? "Replying reopens it" : "Replying brings it back") : `Stays in this ${place} · Shift+Enter for a new line`;
  // A conversation's first message is a turn like the rest; a report opens its thread on its own.
  const shown = task ? turns : replies;
  // The latest exchange starts at the last turn, or the one before it that finished while a newer one is still
  // going, or earlier still at a turn whose card waits on you. -1 is a report thread's report.
  let start = shown.length - 1;
  if (start >= 0 && isLive(shown[start].run)) {
    start--;
    while (start >= 0 && isLive(shown[start].run)) start--;
  }
  const asking = shown.findIndex((t) => waiting(t.run));
  if (asking >= 0) start = Math.min(start, asking);
  if (!task && waiting(root)) start = -1;
  if (!recent || all) start = -1;
  const visible = shown.slice(Math.max(start, 0));
  const showReport = !task && start < 0;
  const earlier = shown.length - visible.length + (task || showReport ? 0 : 1);

  return (
    <div className="thread">
      <ChatSurface
        ref={surface} e={e} busy={!!live} live={live} draftKey={`thread:${rootId}`} scrollKey={liveKey}
        placeholder={`Reply to ${name} in this ${place}…`} hint={hint} onSend={send} onSendDone={onSendDone ?? undefined} onStop={stop} autoFocus={autoFocus}
        actions={live ? null : <button className="btn btn-ghost btn-sm" onClick={() => surface.current?.prefill(TEACH_PREFIX)}><Icon name="teach" size={13} /> Teach a new task</button>}
      >
        <div className="chat-inner">
          {row && row.related.length ? <RowHistory t={row} employees={snap?.employees ?? []} people={snap?.people ?? []} /> : null}
          {earlier ? <button className="btn btn-ghost btn-sm thread-earlier" onClick={() => setAll(true)}>Show {earlier} earlier</button> : null}
          {showReport ? <ReportTurn root={root} events={turns[0].events} e={e} blocked={tail.id === root.id && !archived} archived={archived} /> : null}
          {visible.map((t, i) => (
            <div key={t.run.id} className="stack" style={{ gap: 10 }}>
              <Turn turn={t} e={e} withReport />
              <Flags run={t.run} />
              <RunCards run={t.run} e={e} />
              {i === visible.length - 1 && t.run.denials.length > 0 && t.run.endedAt && !archived ? <BlockedCard run={t.run} employee={e} /> : null}
            </div>
          ))}
        </div>
      </ChatSurface>
    </div>
  );
}

/** The run has a card still waiting on your answer. */
const waiting = (run: Run) => run.cards.some((c) => !c.answer);

/** What Omega Star flagged on a run, apart from its cards. */
function Flags({ run }: { run: Run }) {
  const fs = flags(run);
  if (!fs.length) return null;
  return (
    <ul className="report-needs thread-needs" aria-label="Needs you">
      {fs.map((m, i) => <li key={i}><Icon name="bell" size={12} /><span>{m}</span></li>)}
    </ul>
  );
}

/** The report that started the thread, as the employee's first message, with the pages its run showed above it. */
function ReportTurn({ root, events, e, blocked, archived }: { root: Run; events: RunEvent[]; e: EmployeeView; blocked: boolean; archived: boolean }) {
  const failed = didNotFinish(root);
  return (
    <div className="turn">
      <div className="msg-emp">
        <Avatar name={e.name} hue={e.hue} size={24} presence={isLive(root) ? "working" : undefined} className="msg-av" />
        <div className="msg-body">
          <div className="row" style={{ gap: 8 }}>
            <span className="msg-label">The report</span>
            <span className="grow" />
            {root.endedAt ? <span className="faint thread-time" title={dateLong(root.endedAt)}>{relTime(root.endedAt)}</span> : null}
          </div>
          <Flags run={root} />
          <RunCards run={root} e={e} />
          {events.map((ev, i) => ev.type === "visual" ? <Visual key={i} runId={root.id} id={ev.id} title={ev.title} /> : null)}
          {root.summary ? <Markdown text={root.summary} /> : <p className="muted">{failed ? root.error ?? "This run didn't finish." : "No report."}</p>}
          {root.skillChanges.length ? <SkillsGrew run={root} /> : null}
          {blocked && root.denials.length > 0 ? <BlockedCard run={root} employee={e} /> : null}
          {!archived ? <TidyProposal run={root} employee={e} /> : null}
        </div>
      </div>
    </div>
  );
}

/** Marks the thread with `rootId` done, which archives it. It leaves at once, with nothing to confirm; the Archive
 *  brings it back. Resolves false, having said why and put it back, when it failed. */
export async function markDone(rootId: string): Promise<boolean> {
  dropConversation(rootId);
  try {
    await call("set_archived", { runId: rootId, archived: true });
  } catch (err) {
    refreshConversations();
    toast(errorMessage(err), "err");
    return false;
  }
  return true;
}

/** Brings a thread you marked done back, and offers Undo. */
export async function reopen(rootId: string) {
  try {
    await call("set_archived", { runId: rootId, archived: false });
  } catch (err) {
    toast(errorMessage(err), "err");
    return;
  }
  const undo = () => void call("set_archived", { runId: rootId, archived: true }).catch((err) => toast(errorMessage(err), "err"));
  toast("Reopened", "ok", { label: "Undo", run: undo });
}

/** "Send & done": the reply goes with the thread marked done, and it comes back only if the answer needs you. */
export async function sendAndDone(rootId: string, name: string, text: string, attachments: NewAttachment[]) {
  await call("reply_to_run", { runId: rootId, text, archive: true, attachments });
  toast(`Sent to ${name}. It comes back only if the answer needs you.`, "ok");
}

/** Done is the archive: the thread leaves the Inbox and the employee's chips, and comes back if the employee raises something new. */
export function DoneButton({ name, disabled, onDone }: {
  /** The employee's first name. */
  name: string;
  /** The thread is still working, so it cannot be done yet. */
  disabled: boolean;
  onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn btn-sm" disabled={disabled || busy} title={disabled ? `${name} is still working on it` : "Mark this conversation done (E)"}
      onClick={async () => { setBusy(true); try { await onDone(); } finally { setBusy(false); } }}
    >
      <Icon name="check" size={13} /> Done <kbd className="kbd">E</kbd>
    </button>
  );
}

/** Snooze puts the thread away until a time, then brings it back to the Inbox as unread. While it is snoozed
 *  (`snoozedUntil`), Wake now. */
export function SnoozeButton({ snoozedUntil, onSnooze, onWake }: { snoozedUntil: string | null; onSnooze: (until: Date) => void; onWake: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (snoozedUntil) {
    return (
      <button className="btn btn-ghost btn-sm" onClick={onWake}>
        <Icon name="clock" size={13} /> Wake now
      </button>
    );
  }
  const presets = open ? snoozePresets(new Date()) : [];
  return (
    <>
      <button ref={ref} className="btn btn-ghost btn-sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="clock" size={13} /> Snooze
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={232}>
        <div className="menu" role="menu" aria-label="Snooze until" data-esc-stop>
          {presets.map((s) => (
            <button key={s.label} type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); onSnooze(s.until); }}>
              <span className="grow">{s.label}</span>
              <span className="faint">{whenShort(s.until.toISOString()).replace(s.label === "Tomorrow" ? /^Tomorrow / : /^Today /, "")}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
