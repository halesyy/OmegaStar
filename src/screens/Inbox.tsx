import { useEffect, useRef, useState } from "react";
import { call } from "../api/client";
import type { CardReply, EmployeeView, NewAttachment, Run, Thread } from "../api/types";
import { decisions, type Decision } from "../lib/decisions";
import { dayHeading, firstName } from "../lib/format";
import { useOrg, useProposals, useQuery } from "../lib/hooks";
import { setMark } from "../lib/marks";
import { openMember } from "../lib/router";
import { activityAt, rowCardOpen, rowThreads, threadFocus } from "../lib/threads";
import { RequestCard } from "../components/RequestCard";
import { ProposalCard } from "../components/ProposalCard";
import { AskRow } from "../components/ColleagueAsks";
import { useShell } from "../Shell";
import { Icon } from "../components/Icon";
import { Avatar, ErrorNote, PageColumn, Section, Skeleton } from "../components/ui";
import { answerCard } from "../components/conversation/CardView";
import { lines } from "../components/conversation/RowHistory";
import { markDone, reopen, sendAndDone } from "../components/conversation/ThreadView";
import { toItem, useStatuses, type Item } from "../components/conversation/useStatuses";
import { DecisionItem, FeedItem, type ItemActions } from "./InboxItem";
import "./Inbox.css";

type View = "inbox" | "snoozed" | "archive";

const VIEWS: { id: View; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "snoozed", label: "Snoozed" },
  { id: "archive", label: "Archive" },
];

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** A weekly review, which the Inbox sums up in the week's numbers rather than as a line of its own. */
const isReview = (t: Thread): boolean => t.root.kind.type === "scheduled" && !!t.root.kind.review;

/** Lines under a day heading: the day each moved, or in the Archive the day each was done. */
function byDay(items: Item[], archive: boolean): { day: string; items: Item[] }[] {
  const groups: { day: string; items: Item[] }[] = [];
  for (const i of items) {
    const t = i.thread;
    const day = dayHeading(archive ? t.root.archivedAt ?? activityAt(t) : activityAt(t));
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(i);
    else groups.push({ day, items: [i] });
  }
  return groups;
}

/** The entry to open once `id` leaves the list: the next one down, else the one above. */
function after(ids: string[], id: string): string | null {
  const i = ids.indexOf(id);
  if (i < 0) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

/** An entry with nothing to answer but Done: E marks it done. */
const doneable = (d: Decision<Item>): boolean =>
  (d.type === "flag" ? !d.run.proposed || !!d.run.repliedAt : d.type !== "card" && d.type !== "blocked")
  && !rowCardOpen(d.item.thread) && d.item.status.state !== "working" && d.item.status.state !== "queued";

/**
 * What needs you, then what is going on. The top is decisions: hire proposals, then one entry per question, block
 * or breakage, each answered in place. Below them, the context to make them in: the week's numbers, who you are
 * waiting on, and everything else that reached you in the last week, one line each, asking nothing. Snoozed holds
 * what you put away until later, and the Archive what you dealt with. An entry opens in place into its whole thread;
 * E marks the open decision done (else the one under the pointer).
 */
export function InboxScreen() {
  const { snap } = useOrg();
  const [view, setView] = useState<View>("inbox");
  const { items, ctx, error } = useStatuses();
  const archive = useQuery(() => (view === "archive" ? call("archived") : Promise.resolve(undefined)), [view], ["run:updated"]);
  const updates = useQuery(() => (view === "inbox" ? call("updates") : Promise.resolve(undefined)), [view], ["run:updated"]);
  const waiting = useQuery(() => (view === "inbox" ? call("requests", { personId: null, employeeId: null, state: "open" }) : Promise.resolve(undefined)), [view], ["request:updated", "org:changed"]);
  const asks = useQuery(() => (view === "inbox" ? call("open_asks") : Promise.resolve(undefined)), [view], ["run:updated"]);
  const proposals = (useProposals() ?? []).filter((p) => p.state === "open");
  const shell = useShell();
  const [openId, setOpenId] = useState<string | null>(null);
  const hovered = useRef<string | null>(null);

  const entries: Decision<Item>[] | null =
    view === "inbox" ? (items ? decisions(items.filter((i) => i.status.inbox)) : null)
    : view === "snoozed" ? (items ? decisions(items.filter((i) => i.status.state === "snoozed").sort((a, b) => a.status.snoozedUntil!.localeCompare(b.status.snoozedUntil!))) : null)
    : null;
  const feedOf = (ts: Thread[] | undefined) => (snap && ts ? ts.flatMap((t) => toItem(t, snap, false, ctx) ?? []) : null);
  const updateItems = feedOf(updates.data);
  // A row already up top as a decision is not repeated below.
  const asking = new Set((entries ?? []).flatMap((d) => rowThreads(d.item.thread)).map((x) => x.root.id));
  const feed: Item[] | null =
    view === "inbox" ? updateItems?.filter((i) => !isReview(i.thread) && !rowThreads(i.thread).some((x) => asking.has(x.root.id))) ?? null
    : view === "archive" ? feedOf(archive.data)
    : null;
  const loadError = view === "archive" ? archive.error : error ?? (view === "inbox" ? updates.error : null);
  const ids = entries?.map((d) => d.id) ?? feed?.map((i) => i.thread.root.id) ?? [];

  /** What an entry's buttons do. Done and Snooze move an open entry on to the next, so you work down the list. */
  const actionsFor = (i: Item, id: string): ItemActions => {
    const root = i.thread.root.id;
    const name = firstName(i.employee.name);
    const leaving = () => {
      const next = after(ids, id);
      return () => setOpenId((o) => (o === id ? next : o));
    };
    return {
      done: async () => {
        const go = leaving();
        if (await markDone(root)) go();
      },
      snooze: (until) => {
        const go = leaving();
        setMark(root, { snoozedUntil: until.toISOString() });
        go();
      },
      wake: () => setMark(root, { snoozedUntil: undefined }),
      reopen: () => {
        if (openId === id) setOpenId(null);
        void reopen(root);
      },
      sendDone: async (text: string, attachments: NewAttachment[]) => {
        const go = leaving();
        await sendAndDone(root, name, text, attachments);
        go();
      },
      answer: async (run: Run, index: number, reply: CardReply) => {
        const go = leaving();
        if (await answerCard(run, index, reply, name)) go();
      },
    };
  };

  // E acts on the open entry, else the one under the pointer: Done, or in the Archive, Reopen. An entry with
  // something to answer is answered on its buttons, so E leaves it. Escape closes the entry.
  const latest = useRef({ entries, feed, view, actionsFor, openId });
  latest.current = { entries, feed, view, actionsFor, openId };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || document.querySelector("[role=dialog]")) return;
      const { entries, feed, view, actionsFor, openId } = latest.current;
      if (e.key === "Escape" && openId) { setOpenId(null); return; }
      if (e.key.toLowerCase() !== "e") return;
      const target = openId ?? hovered.current;
      if (view === "archive") {
        const i = feed?.find((x) => x.thread.root.id === target);
        if (!i) return;
        e.preventDefault();
        actionsFor(i, i.thread.root.id).reopen();
        return;
      }
      const d = entries?.find((x) => x.id === target);
      if (!d || !doneable(d)) return;
      e.preventDefault();
      void actionsFor(d.item, d.id).done();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const employees = snap?.employees ?? [];
  const people = snap?.people ?? [];
  const showProposals = view === "inbox" && proposals.length > 0;
  const showWaiting = view === "inbox" && !!waiting.data?.length;
  const showAsks = view === "inbox" && !!asks.data?.length;
  const loaded = view === "archive" ? feed : entries;
  const pick = (v: View) => { setView(v); setOpenId(null); };
  const toggle = (id: string) => setOpenId((o) => (o === id ? null : id));
  const hover = (id: string) => (on: boolean) => { hovered.current = on ? id : hovered.current === id ? null : hovered.current; };

  return (
    <PageColumn
      title="Inbox"
      actions={
        <div className="seg" role="tablist" aria-label="Inbox, snoozed or archive">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} aria-pressed={view === v.id} onClick={() => pick(v.id)}>{v.label}</button>
          ))}
        </div>
      }
    >
      {showProposals ? (
        <Section title="Hire proposals" count={proposals.length}>
          <div className="plist">
            {proposals.map((p) => (
              <ProposalCard key={p.id} p={p} proposer={employees.find((e) => e.id === p.employeeId)} snap={snap} onReview={() => shell.reviewProposal(p)} />
            ))}
          </div>
        </Section>
      ) : null}
      {loadError ? <ErrorNote text={loadError} onRetry={view === "archive" ? archive.reload : view === "inbox" ? updates.reload : undefined} /> : null}
      {!loaded && !loadError ? <div className="stack" style={{ gap: 8 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={56} r={10} />)}</div> : null}
      {view === "archive" && feed?.length === 0 ? <Empty view={view} /> : null}
      {view === "snoozed" && entries?.length === 0 ? <Empty view={view} /> : null}
      {view === "inbox" && entries?.length === 0 && !showProposals ? (
        <Section title="Needs you" count={null}>
          <p className="inbox-clear">Nothing needs you right now.</p>
        </Section>
      ) : null}
      {entries && entries.length > 0 ? (
        <Section title={view === "inbox" ? "Needs you" : "Snoozed"} count={entries.length}>
          <div className="inbox-list">
            {entries.map((d) => (
              <DecisionItem
                key={d.id} d={d} employees={employees} people={people} actions={actionsFor(d.item, d.id)}
                open={openId === d.id} onToggle={() => toggle(d.id)} onHover={hover(d.id)}
              />
            ))}
          </div>
        </Section>
      ) : null}

      {view === "inbox" && updateItems ? <Scoreboard threads={updateItems.map((i) => i.thread)} employees={employees} /> : null}
      {showWaiting ? (
        <Section title="Waiting on people" count={waiting.data!.length} id="waiting">
          <div className="plist">
            {waiting.data!.map((r) => (
              <RequestCard key={r.id} r={r} employee={employees.find((e) => e.id === r.employeeId)} person={people.find((p) => p.id === r.personId)} showPerson onChanged={() => waiting.reload()} />
            ))}
          </div>
        </Section>
      ) : null}
      {showAsks ? (
        <Section title="Between colleagues" count={asks.data!.length}>
          <div className="plist">
            {asks.data!.map((r) => <AskRow key={r.id} run={r} employees={employees} />)}
          </div>
        </Section>
      ) : null}
      {feed && feed.length > 0 ? (
        <Section title={view === "inbox" ? "Last 7 days" : "Archived"} count={null}>
          <div className="inbox-list">
            {byDay(feed, view === "archive").map((g) => (
              <div key={g.day} className="inbox-group" onMouseLeave={() => { hovered.current = null; }}>
                <div className="inbox-day">{g.day}</div>
                {g.items.map((i) => {
                  const id = i.thread.root.id;
                  return (
                    <div key={id} onMouseEnter={() => { hovered.current = id; }}>
                      <FeedItem
                        item={i} employees={employees} people={people} open={openId === id} onToggle={() => toggle(id)}
                        onReopen={view === "archive" ? actionsFor(i, id).reopen : null}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </PageColumn>
  );
}

/** The week in numbers: each employee's latest weekly review, as the number it reported, else its first line. Each
 *  opens the review on the employee's panel. */
function Scoreboard({ threads, employees }: { threads: Thread[]; employees: EmployeeView[] }) {
  const latest = new Map<string, Thread>();
  for (const x of threads.flatMap(rowThreads)) {
    if (!isReview(x) || x.root.state !== "succeeded") continue;
    const had = latest.get(x.root.employeeId);
    if (!had || had.root.createdAt < x.root.createdAt) latest.set(x.root.employeeId, x);
  }
  const rows = [...latest.values()].flatMap((x) => {
    const e = employees.find((m) => m.id === x.root.employeeId);
    return e ? [{ x, e }] : [];
  });
  if (!rows.length) return null;
  return (
    <Section title="This week's numbers" count={null}>
      <div className="score">
        {rows.map(({ x, e }) => {
          const s = x.root.score;
          return (
            <button key={x.root.id} className="score-row" onClick={() => openMember(e.id, "chat", threadFocus(x.root.id))}>
              <Avatar name={e.name} hue={e.hue} size={20} />
              <b className="score-who">{firstName(e.name)}</b>
              {s ? (
                <>
                  <span className="score-metric">{s.metric}</span>
                  <span className="score-value num">{s.value}</span>
                  <span className="score-change faint">{s.change}</span>
                </>
              ) : (
                <span className="score-metric score-plain">{lines(x.root.summary)[0] ?? "Reviewed the week"}</span>
              )}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

/** What an empty Snoozed or Archive says. */
function Empty({ view }: { view: "snoozed" | "archive" }) {
  const [icon, title, text] =
    view === "snoozed" ? ["clock", "Nothing snoozed", "Snooze an entry to put it away until later. It comes back to your Inbox when it wakes."] as const
    : ["archive", "Nothing archived", "What you deal with lands here. If it needs you again, it comes back to your Inbox."] as const;
  return (
    <div className="empty">
      <Icon name={icon} size={22} />
      <span className="empty-title">{title}</span>
      <p>{text}</p>
    </div>
  );
}
