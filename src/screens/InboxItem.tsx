import { useState } from "react";
import { call, errorMessage } from "../api/client";
import type { CardReply, EmployeeView, NewAttachment, PersonView, Run, Thread } from "../api/types";
import type { Decision } from "../lib/decisions";
import { dateLong, firstName, relTime, runKindLabel, whenInline } from "../lib/format";
import { refreshOrg, useThread } from "../lib/hooks";
import { lastMoved, useMarkSeen } from "../lib/marks";
import { openMember } from "../lib/router";
import { toolName } from "../lib/rules";
import { toast } from "../lib/toasts";
import { activityAt, didNotFinish, isTeamWeek, latestFinished, rowCardOpen, rowThreads, STREAK, threadFocus } from "../lib/threads";
import { Icon } from "../components/Icon";
import { Avatar } from "../components/ui";
import { kindNames } from "../components/RunRow";
import { CardView } from "../components/conversation/CardView";
import { lines } from "../components/conversation/RowHistory";
import { DoneButton, SnoozeButton, ThreadView } from "../components/conversation/ThreadView";
import type { Item } from "../components/conversation/useStatuses";

/** What an Inbox row can do to its thread. */
export type ItemActions = {
  /** Mark it done. */
  done: () => Promise<void>;
  snooze: (until: Date) => void;
  wake: () => void;
  reopen: () => void;
  /** Reply and mark it done in one go. */
  sendDone: (text: string, attachments: NewAttachment[]) => Promise<void>;
  /** Answer the card at `index` of `run`'s cards. */
  answer: (run: Run, index: number, reply: CardReply) => Promise<void>;
};

const label = (t: Thread, employees: EmployeeView[], people: PersonView[]) => runKindLabel(t.root.kind, kindNames(t.root, employees, people));

/** The first line of what a run said, or why it said nothing. */
function firstLine(r: Run): string {
  return lines(r.summary)[0] ?? (didNotFinish(r) ? r.error ?? "Didn't finish" : "No report");
}

/** A list of first names, as "Ada, Bo and Cy". */
function names(ids: string[], employees: EmployeeView[]): string {
  const ns = [...new Set(ids)].flatMap((id) => employees.find((x) => x.id === id) ?? []).map((x) => firstName(x.name));
  return ns.length > 1 ? `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}` : ns[0] ?? "";
}

/** A decision as the Inbox shows it: the question, one line on why, and the answer. */
function ask(d: Decision<Item>, who: string, what: string): { title: string; why: string | null } {
  const r = d.run;
  switch (d.type) {
    case "card": return { title: d.card.message, why: d.card.why };
    case "flag":
      return r.kind.type === "tidy" && r.proposed && !r.repliedAt
        ? { title: `Approve ${who}'s skill changes?`, why: lines(r.proposed)[0] ?? null }
        : { title: d.text, why: null };
    case "blocked":
      return {
        title: r.denials.length === 1 ? `Allow ${who} to use ${toolName(r.denials[0].tool)}?` : `Allow ${who} ${r.denials.length} blocked actions?`,
        why: r.denials[0]?.brief ?? null,
      };
    case "broken":
      return { title: d.times >= STREAK ? `${what} failed ${d.times} times in a row` : `${what} didn't finish`, why: r.error ? lines(r.error)[0] ?? null : null };
    case "answered": return { title: firstLine(r), why: lines(r.summary).slice(1).join(" ") || null };
  }
}

/** One decision in the Inbox: who, the question, why it matters, and the buttons that answer it. It opens in place
 *  into the whole thread. Hovering shows Snooze, or Wake now, and the way to the employee's panel. */
export function DecisionItem({ d, employees, people, open, onToggle, onHover, actions }: {
  d: Decision<Item>;
  employees: EmployeeView[];
  people: PersonView[];
  open: boolean;
  onToggle: () => void;
  /** The pointer or focus entered (true) or left the entry, so E knows which one you mean. */
  onHover: (on: boolean) => void;
  actions: ItemActions;
}) {
  const { item } = d;
  const { status } = item;
  const e = employees.find((x) => x.id === d.run.employeeId) ?? item.employee;
  const who = firstName(e.name);
  const what = label(d.thread, employees, people);
  const busy = status.state === "working" || status.state === "queued";
  const { title, why } = ask(d, who, what);
  const also = d.type === "card" ? names(d.also.map((r) => r.employeeId).filter((id) => id !== e.id), employees) : "";
  const at = d.run.endedAt ?? activityAt(item.thread);
  return (
    <article className={`item dec ${open ? "item-open" : ""} ${status.unread ? "item-unread" : ""}`} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
      <div
        className="item-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onToggle(); } }}
        onFocus={() => onHover(true)} onBlur={() => onHover(false)}
      >
        <Avatar name={e.name} hue={e.hue} size={30} presence={busy ? "working" : undefined} />
        <div className="item-main">
          <span className="item-context">
            <b>{e.name}</b><span className="muted"> · {d.type === "answered" ? `replied in ${what}` : what}</span>
            {also ? <span className="muted"> · also {also}</span> : null}
          </span>
          <span className="item-title">
            {d.type === "broken" ? <Icon name="alert" size={13} className="item-failed" /> : null}
            {d.type === "blocked" ? <Icon name="shield" size={13} className="item-bell" /> : null}
            <span>{title}</span>
          </span>
          {why ? <span className="item-why">{why}</span> : null}
          <div className="dec-answer" onClick={(ev) => ev.stopPropagation()}>
            <Answer d={d} e={e} busy={busy} actions={actions} />
          </div>
        </div>
        <div className="item-side">
          {status.unread ? <span className="report-new" aria-label="New" /> : null}
          {status.snoozedUntil
            ? <span className="faint item-when" title={dateLong(status.snoozedUntil)}>Wakes {whenInline(status.snoozedUntil)}</span>
            : <span className="faint item-when" title={dateLong(at)}>{relTime(at)}</span>}
        </div>
        <div className="item-actions" onClick={(ev) => ev.stopPropagation()}>
          <SnoozeButton snoozedUntil={status.snoozedUntil} onSnooze={actions.snooze} onWake={actions.wake} />
          <button className="btn btn-ghost btn-sm btn-icon" title={`Open on ${who}'s panel`} aria-label={`Open on ${who}'s panel`} onClick={() => openMember(e.id, "chat", threadFocus(d.thread.root.id))}>
            <Icon name="org" size={14} />
          </button>
        </div>
      </div>
      {open ? <ItemThread item={item} thread={d.thread} e={e} onSendDone={actions.sendDone} /> : null}
    </article>
  );
}

/** The buttons that answer a decision. Anything that is not a card or a block is dealt with by reading it, so Done;
 *  a row with a card open waits for the card instead. */
function Answer({ d, e, busy, actions }: { d: Decision<Item>; e: EmployeeView; busy: boolean; actions: ItemActions }) {
  const who = firstName(e.name);
  if (d.type === "card") return <CardView card={d.card} e={e} onAnswer={(reply) => actions.answer(d.run, d.index, reply)} />;
  if (d.type === "blocked") return <Allow run={d.run} who={who} />;
  if (d.type === "flag" && d.run.kind.type === "tidy" && d.run.proposed && !d.run.repliedAt) return <ApproveTidy run={d.run} who={who} />;
  if (rowCardOpen(d.item.thread)) return null;
  return (
    <div className="card-choices">
      <DoneButton name={who} disabled={busy} onDone={actions.done} />
    </div>
  );
}

/** Allow what a run was blocked on, once or for good, and it retries. The full choice (a whole MCP server, say) is
 *  in the thread. */
function Allow({ run, who }: { run: Run; who: string }) {
  const [busy, setBusy] = useState(false);
  const rules = [...new Set(run.denials.map((x) => x.suggestedRule))];
  const allow = async (always: boolean) => {
    setBusy(true);
    try {
      await call("approve_blocked", { runId: run.id, rules, always });
      if (always) refreshOrg();
      toast(`${who} is retrying${always ? ", and can do this from now on" : ""}`, "ok");
    } catch (err) {
      toast(errorMessage(err), "err");
      setBusy(false);
    }
  };
  return (
    <div className="card-choices">
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void allow(true)} title={`Saves ${rules.length === 1 ? "the rule" : "the rules"} to ${who}'s profile`}>Always allow</button>
      <button className="btn btn-sm" disabled={busy} onClick={() => void allow(false)}>Just once</button>
    </div>
  );
}

/** Approve the bigger changes a tidy proposed. The plan itself is in the thread. */
function ApproveTidy({ run, who }: { run: Run; who: string }) {
  const [busy, setBusy] = useState(false);
  const approve = async () => {
    setBusy(true);
    try {
      await call("approve_tidy", { runId: run.id });
      toast(`${who} is making those changes now`, "ok");
    } catch (err) {
      toast(errorMessage(err), "err");
      setBusy(false);
    }
  };
  return (
    <div className="card-choices">
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void approve()}><Icon name="check" size={12} /> Approve</button>
    </div>
  );
}

/** One line in the Archive: who, what it was, and the first thing it said. It opens in place into the whole thread.
 *  Hovering shows Reopen when you marked something in it done. */
export function FeedItem({ item, employees, people, open, onToggle, onReopen }: {
  item: Item;
  employees: EmployeeView[];
  people: PersonView[];
  open: boolean;
  onToggle: () => void;
  /** Bring what you marked done back to the Inbox, or null when nothing in it was marked done. */
  onReopen: (() => void) | null;
}) {
  const { thread: t, employee: e } = item;
  const who = firstName(e.name);
  const team = isTeamWeek(t);
  const run = latestFinished(t);
  const failed = didNotFinish(run);
  const text = team ? names(rowThreads(t).map((x) => x.root.employeeId), employees) : run.cards[0] && !lines(run.summary).length ? run.cards[0].message : firstLine(run);
  const at = activityAt(t);
  return (
    <article className={`item feed ${open ? "item-open" : ""}`}>
      <div
        className="item-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onToggle(); } }}
      >
        <Avatar name={e.name} hue={e.hue} size={22} />
        <span className="feed-line">
          <b>{team ? "Your team's week" : who}</b>
          <span className="muted"> · {team ? `${rowThreads(t).length} reviews` : label(t, employees, people)}</span>
          {failed ? <Icon name="alert" size={12} className="item-failed feed-icon" /> : null}
          <span className="feed-text">{text}</span>
        </span>
        <div className="item-side"><span className="faint item-when" title={dateLong(at)}>{relTime(at)}</span></div>
        <div className="item-actions" onClick={(ev) => ev.stopPropagation()}>
          {onReopen ? <button className="btn btn-ghost btn-sm" title="Reopen (E)" onClick={onReopen}><Icon name="undo" size={13} /> Reopen</button> : null}
          <button className="btn btn-ghost btn-sm btn-icon" title={`Open on ${who}'s panel`} aria-label={`Open on ${who}'s panel`} onClick={() => openMember(e.id, "chat", threadFocus(t.root.id))}>
            <Icon name="org" size={14} />
          </button>
        </div>
      </div>
      {open ? <ItemThread item={item} thread={t} e={e} onSendDone={null} /> : null}
    </article>
  );
}

/** An open entry's thread, live: the same conversation the employee's panel shows, seen once it is in front of you.
 *  The row's other runs head it when the thread leads the row. */
function ItemThread({ item, thread, e, onSendDone }: { item: Item; thread: Thread; e: EmployeeView; onSendDone: ItemActions["sendDone"] | null }) {
  const id = thread.root.id;
  const lead = id === item.thread.root.id;
  const live = useThread(id);
  useMarkSeen(item.status.state === "done" ? null : item.thread.root.id, lastMoved(live.turns?.map((t) => t.run) ?? []));
  return (
    <div className="item-thread">
      <ThreadView e={e} rootId={id} thread={live} row={lead ? item.thread : null} onSendDone={item.status.state === "done" ? null : onSendDone} autoFocus={false} />
    </div>
  );
}
