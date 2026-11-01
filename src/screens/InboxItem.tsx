import { useEffect, useRef, useState, type ReactNode } from "react";
import { call, errorMessage } from "../api/client";
import type { CardReply, EmployeeView, NewAttachment, PersonView, Run, Thread } from "../api/types";
import { recommended, type CardDecision, type Decision, type Group } from "../lib/decisions";
import { dateLong, firstName, relTime, runKindLabel, threadTitle, whenInline } from "../lib/format";
import { refreshOrg, useThread } from "../lib/hooks";
import { lastMoved, useMarkSeen } from "../lib/marks";
import { openMember } from "../lib/router";
import { toolName } from "../lib/rules";
import { toast } from "../lib/toasts";
import { activityAt, archivable, didNotFinish, doneHeld, isLive, isOpen, isTeamWeek, latestFinished, rowThreads, STREAK, threadBusy, threadFocus, type OpenCard } from "../lib/threads";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { Avatar, Popover } from "../components/ui";
import { kindNames } from "../components/RunRow";
import { answerCard, CardList, CardView, usePendingAnswers } from "../components/conversation/CardView";
import { lines } from "../components/conversation/RowHistory";
import { DoneButton, RetryButton, SnoozeButton, ThreadView } from "../components/conversation/ThreadView";
import type { Item } from "../components/conversation/useStatuses";

/** What an Inbox entry can do to the threads it is about. */
export type ItemActions = {
  /** Archive it. */
  done: () => Promise<void>;
  /** Put it away until `until` (Later). */
  snooze: (until: Date) => void;
  wake: () => void;
  /** Reply and archive it in one go. */
  sendDone: (text: string, attachments: NewAttachment[]) => Promise<void>;
  /** Answer the card at `index` of `run`'s cards. */
  answer: (run: Run, index: number, reply: CardReply) => Promise<void>;
  /** Answer each of these cards with what its employee recommends, once you confirmed. */
  answerAll: (cards: OpenCard[]) => Promise<void>;
};

type Failures = Extract<Decision<Item>, { type: "failures" }>;

const handOff = (r: Run): boolean => r.kind.type === "asked" || r.kind.type === "delegated" || r.kind.type === "answered";

/** A thread's own name: its title, a routine's label or a conversation's name. Null for a hand-off with no title of
 *  its own, which `threadTitle` names by how it came, as "Task from Bo". */
function ownName(r: Run, employees: EmployeeView[], people: PersonView[]): string | null {
  const names = kindNames(r, employees, people);
  const title = threadTitle(r, names);
  return handOff(r) && title === runKindLabel(r.kind, names) ? null : title;
}

/** What an entry is about rather than how it came: the thread's own name, and on a hand-off who it is for (or, for an
 *  answer that came back, who it is from), as "Pricing page for Bo". */
function topic(t: Thread, employees: EmployeeView[], people: PersonView[]): string {
  const r = t.root;
  const names = kindNames(r, employees, people);
  const them = handOff(r) ? names.asker ?? names.manager : undefined;
  const other = them ? `${r.kind.type === "answered" ? "from" : "for"} ${them}` : null;
  return [ownName(r, employees, people), other].filter(Boolean).join(" ") || threadTitle(r, names);
}

/** The first line of what a run said, or why it said nothing. */
function firstLine(r: Run): string {
  return lines(r.summary)[0] ?? (didNotFinish(r) ? r.error ?? "Didn't finish" : "No report");
}

/** A list of first names, as "Ada, Bo and Cy". */
function names(ids: string[], employees: EmployeeView[]): string {
  const ns = [...new Set(ids)].flatMap((id) => employees.find((x) => x.id === id) ?? []).map((x) => firstName(x.name));
  return ns.length > 1 ? `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}` : ns[0] ?? "";
}

/** A decision as the Inbox shows it: the question and one line on why. `name`: the thread's own name, if it has one. */
function ask(d: Decision<Item>, who: string, name: string | null): { title: string; why: string | null } {
  const r = d.run;
  switch (d.type) {
    case "card": {
      if (d.cards.length === 1) return { title: d.cards[0].card.message, why: d.cards[0].card.why };
      // News asks nothing, so they do not wait for it.
      const answered = d.cards.filter((c) => c.card.answer).length;
      const asked = answered + d.cards.filter((c) => isOpen(c.card)).length;
      return { title: `${d.cards.length} questions`, why: asked > 1 ? `${answered} of ${asked} answered. ${who} hears your answers together, once all are in.` : null };
    }
    case "flag":
      return r.kind.type === "tidy" && r.proposed && !r.approvedAt
        ? { title: `Approve ${who}'s skill changes?`, why: lines(r.proposed)[0] ?? null }
        : { title: d.text, why: null };
    case "blocked":
      return {
        title: r.denials.length === 1 ? `Allow ${who} to use ${toolName(r.denials[0].tool)}?` : `Allow ${who} ${r.denials.length} blocked actions?`,
        why: r.denials[0]?.brief ?? null,
      };
    case "broken":
      return {
        title: d.times >= STREAK ? `${name ?? "A routine"} failed ${d.times} times in a row` : name ? `${name} didn't finish` : "Didn't finish",
        why: r.error ? lines(r.error)[0] ?? null : null,
      };
    case "failures": return { title: `${d.failures.length} runs didn't finish: ${lines(r.error)[0] ?? ""}`, why: null };
    case "answered": return { title: firstLine(r), why: lines(r.summary).slice(1).join(" ") || null };
  }
}

/** One decision in the Inbox: who, what about, the question, why it matters, the report behind it on request, and the
 *  buttons that answer it. It opens in place into its whole thread, or for runs that didn't finish together into the
 *  list of them. Hovering shows Later (Wake now while it is away; a card has a Later of its own) and the way to the
 *  employee's panel. `settled`: it left while the pointer was over the list, so it keeps its place, faded and inert,
 *  without its card's buttons, which would offer it again once its answer is no longer on its way. */
export function DecisionItem({ d, employees, people, open, onToggle, actions, settled = false }: {
  d: Decision<Item>;
  employees: EmployeeView[];
  people: PersonView[];
  open: boolean;
  onToggle: () => void;
  actions: ItemActions;
  settled?: boolean;
}) {
  const { item } = d;
  const { status } = item;
  const e = employees.find((x) => x.id === d.run.employeeId) ?? item.employee;
  const who = firstName(e.name);
  // Archive acts on the decision's own conversation, so it waits on that one, not on whichever leads the row.
  const busy = threadBusy(d.thread);
  const { title, why } = ask(d, who, ownName(d.thread.root, employees, people));
  const failures = d.type === "failures" ? d.failures : null;
  const also = d.type === "card" ? names(d.also.map((r) => r.employeeId).filter((id) => id !== e.id), employees) : "";
  const report = d.type !== "answered" && !failures && !open ? d.run.summary : null;
  const at = d.run.endedAt ?? activityAt(item.thread);
  return (
    <article className={`item dec ${open ? "item-open" : ""} ${status.unread ? "item-unread" : ""} ${settled ? "item-settled" : ""}`} data-entry={d.id} inert={settled}>
      <div
        className="item-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onToggle(); } }}
      >
        <Avatar name={e.name} hue={e.hue} size={30} presence={busy ? "working" : undefined} />
        <div className="item-main">
          <span className="item-context">
            {failures ? <b>{names(failures.map((f) => f.run.employeeId), employees)}</b> : <><b>{e.name}</b><span className="muted"> · {topic(d.thread, employees, people)}</span></>}
            {also ? <span className="muted"> · also {also}</span> : null}
          </span>
          <span className="item-title">
            {d.type === "broken" || failures ? <Icon name="alert" size={13} className="item-failed" /> : null}
            {d.type === "blocked" ? <Icon name="shield" size={13} className="item-bell" /> : null}
            <span>{title}</span>
          </span>
          {why ? <span className="item-why">{why}</span> : null}
          {report ? <ReportPreview text={report} /> : null}
          {settled && d.type === "card" ? null : (
            <div className="dec-answer" onClick={(ev) => ev.stopPropagation()}>
              <Answer d={d} e={e} busy={busy} employees={employees} actions={actions} />
            </div>
          )}
        </div>
        <div className="item-side">
          {settled ? <span className="faint item-when"><Icon name="check" size={12} /> Cleared</span> : (
            <>
              {status.unread ? <span className="report-new" aria-label="New" /> : null}
              {status.snoozedUntil
                ? <span className="faint item-when" title={dateLong(status.snoozedUntil)}>Wakes {whenInline(status.snoozedUntil)}</span>
                : <span className="faint item-when" title={dateLong(at)}>{relTime(at)}</span>}
            </>
          )}
        </div>
        <div className="item-actions" onClick={(ev) => ev.stopPropagation()}>
          {d.type !== "card" || status.snoozedUntil ? <SnoozeButton snoozedUntil={status.snoozedUntil} onSnooze={actions.snooze} onWake={actions.wake} /> : null}
          {failures ? null : (
            <button className="btn btn-ghost btn-sm btn-icon" title={`Open on ${who}'s panel`} aria-label={`Open on ${who}'s panel`} onClick={() => openMember(e.id, "chat", threadFocus(d.thread.root.id))}>
              <Icon name="org" size={14} />
            </button>
          )}
        </div>
      </div>
      {open ? (failures ? <FailureList failures={failures} employees={employees} people={people} /> : <ItemThread item={item} thread={d.thread} e={e} onSendDone={actions.sendDone} />) : null}
    </article>
  );
}

/** The buttons that answer a decision. A card is answered on the card: a run's several questions as a short list
 *  (`CardSet`), and under a question the cards of others asking it with other choices. Anything that is not a card or
 *  a block is dealt with by reading it, so Archive; while a card Archive would settle is open (`doneHeld`), it waits for
 *  the card instead. A run that didn't finish can be tried again, unless it is a routine failing time after time, which
 *  its next run tries anyway; runs that didn't finish on the same error are tried again, or archived, all together. A
 *  tidy's proposal is approved here until you approve it: asking about it decides nothing, and until you ask, Approve
 *  is all it offers. */
function Answer({ d, e, busy, employees, actions }: { d: Decision<Item>; e: EmployeeView; busy: boolean; employees: EmployeeView[]; actions: ItemActions }) {
  const who = firstName(e.name);
  if (d.type === "card") {
    const c = d.cards[0];
    return (
      <>
        {d.cards.length > 1
          ? <CardSet d={d} e={e} actions={actions} />
          : <CardView card={c.card} runId={c.run.id} index={c.index} e={e} working={isLive(c.run)} onAnswer={(reply) => actions.answer(c.run, c.index, reply)} />}
        {d.differ.length ? <OtherChoices cards={d.differ} employees={employees} actions={actions} /> : null}
      </>
    );
  }
  if (d.type === "blocked") return <Allow run={d.run} who={who} />;
  if (d.type === "failures") return <RetryAll d={d} onArchive={actions.done} />;
  const root = d.thread.root;
  const approve = root.kind.type === "tidy" && !!root.proposed && !root.approvedAt && !root.archivedAt;
  const retry = d.type === "broken" && root.kind.type !== "scheduled";
  const done = !(approve && d.type === "flag") && !doneHeld(d.thread, d.item.thread);
  if (!approve && !retry && !done) return null;
  return (
    <div className="card-choices">
      {approve ? <ApproveTidy run={root} who={who} /> : null}
      {retry ? <RetryButton run={d.run} name={who} disabled={busy} /> : null}
      {done ? <DoneButton name={who} disabled={busy} onDone={actions.done} /> : null}
    </div>
  );
}

/** A run's several questions as a short list, each with the answer its employee recommends; a click shows that card,
 *  to answer it there. Answer all recommended sends each choice card its recommended choice, once you confirm, leaving
 *  out news, which asks nothing, and the cards you answered yourself that are still on their way. While the run is
 *  still working, nothing is answered yet. */
function CardSet({ d, e, actions }: { d: CardDecision<Item>; e: EmployeeView; actions: ItemActions }) {
  const [shown, setShown] = useState<number | null>(null);
  const going = usePendingAnswers();
  const open = d.cards.filter((c) => isOpen(c.card) && !isLive(c.run) && !going.some((p) => p.runId === c.run.id && p.index === c.index));
  const all = open.filter((c) => recommended(c.card));
  return (
    <div className="card-set">
      <ul className="card-qs">
        {d.cards.map((c) => {
          const on = shown === c.index;
          const rec = c.card.answer ? null : recommends(c);
          const said = c.card.answer ? "Answered" : rec ? `Recommended: ${rec}` : "";
          return (
            <li key={c.index}>
              <button type="button" className="card-qs-row" aria-expanded={on} aria-label={[c.card.message, said].filter(Boolean).join(". ")} onClick={() => setShown(on ? null : c.index)}>
                <Icon name="chevronRight" size={12} className="card-qs-chev" />
                <span className="card-qs-q">{c.card.message}</span>
                <span className="card-qs-a">{c.card.answer ? "Answered" : rec}</span>
              </button>
              {on ? (
                <div className="card-ask">
                  {c.card.why ? <div className="card-why">{c.card.why}</div> : null}
                  <CardView card={c.card} runId={c.run.id} index={c.index} e={e} working={isLive(c.run)} onAnswer={(reply) => actions.answer(c.run, c.index, reply)} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {all.length > 1 ? (
        <div className="card-choices">
          <AnswerAll label="Answer all recommended" who={firstName(e.name)} cards={all} left={open.length - all.length} align="start" onConfirm={() => actions.answerAll(all)} />
        </div>
      ) : null}
    </div>
  );
}

/** What a card's employee recommends, in a few words: the choice they marked, or how many of a list they ticked. */
function recommends({ card }: OpenCard): string | null {
  const ask = card.ask;
  if (ask.type === "choices") return ask.choices[ask.recommended];
  if (ask.type !== "items") return null;
  const n = ask.items.filter((i) => i.recommended).length;
  return n ? `${ask.verb} ${n} of ${ask.items.length}` : null;
}

/** Others asking the same thing with choices of their own: each one's question and recommendation, answered here too.
 *  Whichever you answer goes to everyone asking. */
function OtherChoices({ cards, employees, actions }: { cards: OpenCard[]; employees: EmployeeView[]; actions: ItemActions }) {
  return (
    <div className="dec-others">
      {cards.map((c) => {
        const e = employees.find((x) => x.id === c.run.employeeId);
        if (!e) return null;
        return (
          <div key={`${c.run.id}:${c.index}`} className="card-ask">
            <div className="card-q"><span className="muted">{firstName(e.name)} asks:</span> {c.card.message}</div>
            {c.card.why ? <div className="card-why">{c.card.why}</div> : null}
            <CardView card={c.card} runId={c.run.id} index={c.index} e={e} working={isLive(c.run)} onAnswer={(reply) => actions.answer(c.run, c.index, reply)} />
          </div>
        );
      })}
      <p className="dec-others-note">Whichever you answer goes to everyone asking.</p>
    </div>
  );
}

/** A button that answers several cards with what their employee recommends, once you have seen each card and the
 *  answer it gets. `left`: questions of theirs it leaves open. */
function AnswerAll({ label, who, cards, left = 0, align = "end", onConfirm }: {
  label: string;
  who: string;
  cards: OpenCard[];
  left?: number;
  align?: "start" | "end";
  onConfirm: () => Promise<void>;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) requestAnimationFrame(() => yes.current?.focus());
  }, [open]);
  const go = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); setOpen(false); }
  };
  return (
    <>
      <button ref={anchor} type="button" className="btn btn-sm" data-answer-all aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="checklist" size={13} /> {label}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={360} align={align}>
        <div className="answer-all">
          <p className="answer-all-q">Answer {cards.length} with {who}'s recommendation?</p>
          <ul className="answer-all-list">
            {cards.map((c) => (
              <li key={`${c.run.id}:${c.index}`}>
                <span className="answer-all-card">{c.card.message}</span>
                <span className="answer-all-pick">{recommends(c)}</span>
              </li>
            ))}
          </ul>
          {left ? <p className="answer-all-note">{left === 1 ? "The other question stays open for you." : `The other ${left} stay open for you.`}</p> : null}
          <div className="answer-all-foot">
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setOpen(false); anchor.current?.focus(); }}>Cancel</button>
            <button ref={yes} type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void go()}>Answer {cards.length}</button>
          </div>
        </div>
      </Popover>
    </>
  );
}

/** One employee's choice cards about the same thing under one heading, with Approve all recommended. `live`: those
 *  still waiting on you; the rest left while the pointer was over the list and keep their place. Approve all leaves out
 *  a card you answered yourself that is still on its way, and one whose run is still working. */
export function DecisionGroup({ g, employees, live, onApprove, children }: {
  g: Group<Item>;
  employees: EmployeeView[];
  live: CardDecision<Item>[];
  onApprove: (cards: OpenCard[]) => Promise<void>;
  children: ReactNode;
}) {
  const going = usePendingAnswers();
  const e = employees.find((x) => x.id === g.employeeId);
  const who = e ? firstName(e.name) : "Someone";
  const what = `${live.length} ${live.length === 1 ? "decision" : "decisions"} about ${g.about}`;
  const cards = live.map((d) => d.cards[0]).filter((c) => !isLive(c.run) && !going.some((p) => p.runId === c.run.id && p.index === c.index));
  return (
    <div className="dec-group" role="group" aria-label={`${who}: ${what}`}>
      <div className={`dec-group-head ${live.length ? "" : "item-settled"}`}>
        <span className="grow"><b>{who}</b> · {what}</span>
        {cards.length > 1 ? <AnswerAll label="Approve all recommended" who={who} cards={cards} onConfirm={() => onApprove(cards)} /> : null}
      </div>
      {children}
    </div>
  );
}

/** The report of the run a decision is about, without opening the thread: its first paragraph, then More for the rest. */
function ReportPreview({ text }: { text: string }) {
  const [shown, setShown] = useState<"none" | "start" | "all">("none");
  const start = text.split(/\n\s*\n/).find((p) => p.trim()) ?? text;
  return (
    <div className="item-report" onClick={(ev) => ev.stopPropagation()}>
      <button type="button" className="item-report-toggle" aria-expanded={shown !== "none"} onClick={() => setShown(shown === "none" ? "start" : "none")}>
        <Icon name="chevronRight" size={12} /> {shown === "none" ? "Show report" : "Hide report"}
      </button>
      {shown !== "none" ? (
        <div className="item-report-body">
          <Markdown text={shown === "all" ? text : start} />
          {shown === "start" && start.trim() !== text.trim() ? <button type="button" className="btn btn-ghost btn-sm item-report-more" onClick={() => setShown("all")}>More</button> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Allow what a run was blocked on, once or for good, and it retries. Just once is the safe default, as in the thread,
 *  where the full choice (a whole MCP server, say) is. */
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
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void allow(false)}>Just once</button>
      <button className="btn btn-sm" disabled={busy} onClick={() => void allow(true)} title={`Saves ${rules.length === 1 ? "the rule" : "the rules"} to ${who}'s profile`}>Always allow</button>
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
  return <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void approve()}><Icon name="check" size={12} /> Approve</button>;
}

/** Retry all and Archive all, for runs that didn't finish on the same error. Each retry carries on where it stopped. */
function RetryAll({ d, onArchive }: { d: Failures; onArchive: () => Promise<void> }) {
  const [trying, setTrying] = useState(false);
  const retry = async () => {
    setTrying(true);
    const tries = await Promise.allSettled(d.failures.map((f) => call("retry_run", { runId: f.run.id })));
    // An answer Omega Star already sent again is on its way: nothing to retry, and nothing went wrong.
    const again = (t: PromiseSettledResult<unknown>) => t.status === "rejected" && /already went again/.test(errorMessage(t.reason));
    const went = tries.filter((t) => t.status === "fulfilled" || again(t)).length;
    const failed = tries.find((t) => t.status === "rejected" && !again(t));
    if (went) toast(`Trying ${went === 1 ? "1 run" : `${went} runs`} again`, "ok");
    if (failed?.status === "rejected") toast(errorMessage(failed.reason), "err");
    if (!went) setTrying(false);
  };
  const ready = d.failures.some((f) => archivable(f.thread, f.item.thread));
  return (
    <div className="card-choices">
      <button className="btn btn-sm" disabled={trying} title="Try each one again from where it stopped" onClick={() => void retry()}>
        <Icon name="refresh" size={13} /> Retry all
      </button>
      <DoneButton name="Each of them" label="Archive all" disabled={!ready} onDone={onArchive} />
    </div>
  );
}

/** The runs an entry of failures stands for: who, what each was about, when it stopped, and the way to its thread. */
function FailureList({ failures, employees, people }: { failures: Failures["failures"]; employees: EmployeeView[]; people: PersonView[] }) {
  return (
    <div className="item-thread">
      {failures.map((f) => {
        const e = employees.find((x) => x.id === f.run.employeeId);
        const at = f.run.endedAt ?? f.run.createdAt;
        return (
          <div key={f.id} className="row-run">
            {e ? <Avatar name={e.name} hue={e.hue} size={20} /> : <span className="row-run-noav" />}
            <div className="row-run-main">
              <span className="row-run-head"><b>{e ? firstName(e.name) : "Former employee"}</b><span className="muted"> · {topic(f.thread, employees, people)}</span></span>
            </div>
            <span className="faint row-run-when" title={dateLong(at)}>{relTime(at)}</span>
            {e ? (
              <button className="btn btn-ghost btn-sm btn-icon" title={`Open on ${firstName(e.name)}'s panel`} aria-label={`Open on ${firstName(e.name)}'s panel`} onClick={() => openMember(e.id, "chat", threadFocus(f.thread.root.id))}>
                <Icon name="org" size={13} />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** A run holding cards you parked: who asked, what about, and the cards, answered here as on any card. */
export function ParkedItem({ run, employees, people }: { run: Run; employees: EmployeeView[]; people: PersonView[] }) {
  const e = employees.find((x) => x.id === run.employeeId);
  if (!e) return null;
  const who = firstName(e.name);
  const cards = run.cards.flatMap((card, index) => (card.parked ? [{ card, index }] : []));
  const answer = async (index: number, reply: CardReply) => { await answerCard(run, index, reply, who); };
  const one = cards.length === 1 ? cards[0] : null;
  const working = isLive(run);
  const at = run.endedAt ?? run.createdAt;
  return (
    <article className="item dec" data-entry={run.id} tabIndex={-1} aria-label={`${who}: ${one ? one.card.message : `${cards.length} questions`}`}>
      <div className="item-head item-head-still">
        <Avatar name={e.name} hue={e.hue} size={30} />
        <div className="item-main">
          <span className="item-context"><b>{e.name}</b><span className="muted"> · {topic({ root: run, replies: [], related: [] }, employees, people)}</span></span>
          <span className="item-title"><span>{one ? one.card.message : `${cards.length} questions`}</span></span>
          {one?.card.why ? <span className="item-why">{one.card.why}</span> : null}
          {run.summary ? <ReportPreview text={run.summary} /> : null}
          <div className="dec-answer">
            {one
              ? <CardView card={one.card} runId={run.id} index={one.index} e={e} working={working} onAnswer={(reply) => answer(one.index, reply)} />
              : <div className="card-set"><CardList runId={run.id} cards={cards} e={e} working={working} onAnswer={answer} /></div>}
          </div>
        </div>
        <div className="item-side"><span className="faint item-when" title={dateLong(at)}>{relTime(at)}</span></div>
      </div>
    </article>
  );
}

/** One line in the Archive: who, what it was about, and the first thing it said. It opens in place into the whole
 *  thread. Hovering shows Reopen when you archived something in it. */
export function FeedItem({ item, employees, people, open, onToggle, onReopen }: {
  item: Item;
  employees: EmployeeView[];
  people: PersonView[];
  open: boolean;
  onToggle: () => void;
  /** Bring what you archived back to the Inbox, or null when nothing in it was archived by you. */
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
    <article className={`item feed ${open ? "item-open" : ""}`} data-entry={t.root.id}>
      <div
        className="item-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onToggle(); } }}
      >
        <Avatar name={e.name} hue={e.hue} size={22} />
        <span className="feed-line">
          <b>{team ? "Your team's week" : who}</b>
          <span className="muted"> · {team ? `${rowThreads(t).length} reviews` : topic(t, employees, people)}</span>
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
      <ThreadView e={e} rootId={id} thread={live} row={lead ? item.thread : null} onSendDone={item.status.state === "done" ? null : onSendDone} autoFocus={false} recent />
    </div>
  );
}
