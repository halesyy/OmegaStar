import { useEffect, useRef, useState } from "react";
import { call } from "../api/client";
import type { CardReply, NewAttachment, Run, Thread } from "../api/types";
import { decisions, type Decision } from "../lib/decisions";
import { dayHeading, firstName } from "../lib/format";
import { useOrg, useProposals, useQuery } from "../lib/hooks";
import { setMark } from "../lib/marks";
import { archiveAt, doneHeld, threadBusy, wasArchived } from "../lib/threads";
import { ProposalCard } from "../components/ProposalCard";
import { useShell } from "../Shell";
import { Icon } from "../components/Icon";
import { ErrorNote, PageColumn, Section, Skeleton } from "../components/ui";
import { answerCard } from "../components/conversation/CardView";
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

/** Archive lines under a day heading: the day each was done or last moved, the order the Archive comes in. */
function byDay(items: Item[]): { day: string; items: Item[] }[] {
  const groups: { day: string; items: Item[] }[] = [];
  for (const i of items) {
    const day = dayHeading(archiveAt(i.thread));
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
  (d.type === "flag" ? !d.run.proposed || !!d.run.approvedAt : d.type !== "card" && d.type !== "blocked")
  && !doneHeld(d.thread, d.item.thread) && !threadBusy(d.thread);

/**
 * Only what needs you: hire proposals, then one entry per question, block or breakage, and every conversation where
 * it is your turn, each answered in place. Snoozed holds what you put away until later. The Archive holds everything
 * else that reached you, one line each, asking nothing, with what you marked done, newest first by day. Who you are
 * waiting on and the week's numbers are on the Activity page. An entry opens in place into its whole thread; E marks
 * the open decision done (else the one under the pointer), or in the Archive reopens what you marked done.
 */
export function InboxScreen() {
  const { snap } = useOrg();
  const [view, setView] = useState<View>("inbox");
  const { items, ctx, error } = useStatuses();
  const archive = useQuery(() => (view === "archive" ? call("archived") : Promise.resolve(undefined)), [view], ["run:updated"]);
  const proposals = (useProposals() ?? []).filter((p) => p.state === "open");
  const shell = useShell();
  const [openId, setOpenId] = useState<string | null>(null);
  const hovered = useRef<string | null>(null);

  const entries: Decision<Item>[] | null =
    view === "inbox" ? (items ? decisions(items.filter((i) => i.status.inbox)) : null)
    : view === "snoozed" ? (items ? decisions(items.filter((i) => i.status.state === "snoozed").sort((a, b) => a.status.snoozedUntil!.localeCompare(b.status.snoozedUntil!))) : null)
    : null;
  const feed: Item[] | null =
    view === "archive" && snap && archive.data ? archive.data.flatMap((t: Thread) => toItem(t, snap, false, ctx) ?? []) : null;
  const loadError = view === "archive" ? archive.error : error;
  const ids = entries?.map((d) => d.id) ?? feed?.map((i) => i.thread.root.id) ?? [];

  /** What an entry's buttons do. Done and Snooze move an open entry on to the next, so you work down the list. Done and
   *  Send & Done act on `thread`, the conversation the entry is in; Snooze and Reopen on the whole row. */
  const actionsFor = (i: Item, id: string, thread: Thread = i.thread): ItemActions => {
    const root = i.thread.root.id;
    const name = firstName(i.employee.name);
    const leaving = () => {
      const next = after(ids, id);
      return () => setOpenId((o) => (o === id ? next : o));
    };
    return {
      done: async () => {
        const go = leaving();
        if (await markDone(thread.root.id)) go();
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
        await sendAndDone(thread.root.id, name, text, attachments);
        go();
      },
      // A run asking several things stays until its last card is answered.
      answer: async (run: Run, index: number, reply: CardReply) => {
        const go = leaving();
        const last = !run.cards.some((c, i) => i !== index && !c.answer);
        if (await answerCard(run, index, reply, name) && last) go();
      },
    };
  };

  // E acts on the open entry, else the one under the pointer: Done, or in the Archive, Reopen what you marked done.
  // An entry with something to answer is answered on its buttons, so E leaves it. Escape closes the entry.
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
        if (!i || !wasArchived(i.thread)) return;
        e.preventDefault();
        actionsFor(i, i.thread.root.id).reopen();
        return;
      }
      const d = entries?.find((x) => x.id === target);
      if (!d || !doneable(d)) return;
      e.preventDefault();
      void actionsFor(d.item, d.id, d.thread).done();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const employees = snap?.employees ?? [];
  const people = snap?.people ?? [];
  const showProposals = view === "inbox" && proposals.length > 0;
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
      {loadError ? <ErrorNote text={loadError} onRetry={view === "archive" ? archive.reload : undefined} /> : null}
      {!loaded && !loadError ? <div className="stack" style={{ gap: 8 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={56} r={10} />)}</div> : null}
      {view === "archive" && feed?.length === 0 ? <Empty view={view} /> : null}
      {view === "snoozed" && entries?.length === 0 ? <Empty view={view} /> : null}
      {view === "inbox" && entries?.length === 0 && !showProposals ? (
        <Section
          title="Needs you" count={null}
          action={<button className="btn btn-ghost btn-sm" onClick={() => pick("archive")}><Icon name="archive" size={13} /> Archive</button>}
        >
          <p className="inbox-clear">Nothing needs you right now.</p>
        </Section>
      ) : null}
      {entries && entries.length > 0 ? (
        <Section title={view === "inbox" ? "Needs you" : "Snoozed"} count={entries.length}>
          <div className="inbox-list">
            {entries.map((d) => (
              <DecisionItem
                key={d.id} d={d} employees={employees} people={people} actions={actionsFor(d.item, d.id, d.thread)}
                open={openId === d.id} onToggle={() => toggle(d.id)} onHover={hover(d.id)}
              />
            ))}
          </div>
        </Section>
      ) : null}

      {feed && feed.length > 0 ? (
        <Section title="Archived" count={null}>
          <div className="inbox-list">
            {byDay(feed).map((g) => (
              <div key={g.day} className="inbox-group" onMouseLeave={() => { hovered.current = null; }}>
                <div className="inbox-day">{g.day}</div>
                {g.items.map((i) => {
                  const id = i.thread.root.id;
                  return (
                    <div key={id} onMouseEnter={() => { hovered.current = id; }}>
                      <FeedItem
                        item={i} employees={employees} people={people} open={openId === id} onToggle={() => toggle(id)}
                        onReopen={wasArchived(i.thread) ? actionsFor(i, id).reopen : null}
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

/** What an empty Snoozed or Archive says. */
function Empty({ view }: { view: "snoozed" | "archive" }) {
  const [icon, title, text] =
    view === "snoozed" ? ["clock", "Nothing snoozed", "Snooze an entry to put it away until later. It comes back to your Inbox when it wakes."] as const
    : ["archive", "Nothing in the Archive", "Everything that reaches you and needs nothing from you lands here, with what you mark done. If it needs you again, it comes back to your Inbox."] as const;
  return (
    <div className="empty">
      <Icon name={icon} size={22} />
      <span className="empty-title">{title}</span>
      <p>{text}</p>
    </div>
  );
}
