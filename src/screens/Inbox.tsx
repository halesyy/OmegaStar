import { useEffect, useRef, useState, type ReactNode } from "react";
import { call, errorMessage } from "../api/client";
import type { Run, Thread } from "../api/types";
import { decisions, inboxLists, recommended, type Decision, type Group } from "../lib/decisions";
import { dayHeading, firstName } from "../lib/format";
import { useOrg, useProposals, useQuery } from "../lib/hooks";
import { setMark } from "../lib/marks";
import { toast } from "../lib/toasts";
import { archiveAt, archivable, isOpen, wasArchived, type OpenCard } from "../lib/threads";
import { ProposalCard } from "../components/ProposalCard";
import { useShell } from "../Shell";
import { Icon } from "../components/Icon";
import { ErrorNote, PageColumn, Popover, Section, Skeleton } from "../components/ui";
import { answerCard, answering, undoLatest } from "../components/conversation/CardView";
import { markDone, reopen, sendAndDone } from "../components/conversation/ThreadView";
import { toItem, useStatuses, type Item } from "../components/conversation/useStatuses";
import { DecisionGroup, DecisionItem, FeedItem, ParkedItem, type ItemActions } from "./InboxItem";
import "./Inbox.css";

type View = "inbox" | "snoozed" | "parked" | "archive";

const VIEWS: { id: View; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "snoozed", label: "Snoozed" },
  { id: "parked", label: "Parked" },
  { id: "archive", label: "Archive" },
];

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

const kbd = (k: string) => <kbd className="kbd">{k}</kbd>;

/** The keys the Inbox answers to, as ? lists them. */
const KEYS: [ReactNode, string][] = [
  [<>{kbd("J")} {kbd("K")}</>, "Next or previous entry, as ↓ and ↑ do"],
  [kbd("Enter"), "Open or close the entry"],
  [kbd("A"), "The recommended choice, or the card's main answer"],
  [<>{kbd("1")} to {kbd("4")}</>, "Pick that choice"],
  [kbd("L"), "Later"],
  [kbd("X"), "No, Can't or Not now"],
  [kbd("Z"), "Undo your last answer before it goes"],
  [kbd("R"), "Reply on the card"],
  [kbd("E"), "Archive"],
  [kbd("Esc"), "Close the entry"],
  [kbd("?"), "Show these keys"],
];

/** Archive lines under a day heading: the day each was archived or last moved, the order the Archive comes in. */
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

/** An entry with nothing to answer but Archive: E archives it, runs that didn't finish together all at once. A tidy's
 *  proposal you have not asked about is answered with Approve. */
const doneable = (d: Decision<Item>): boolean =>
  d.type === "failures" ? d.failures.some((f) => archivable(f.thread, f.item.thread))
  : (d.type === "flag" ? !d.thread.root.proposed || !!d.thread.root.approvedAt : d.type !== "card" && d.type !== "blocked") && archivable(d.thread, d.item.thread);

/** The entries on the page, in order, leaving out those that only keep their place. */
const onPage = () => [...document.querySelectorAll<HTMLElement>("[data-entry]:not([inert])")];

/** Focuses an entry: its head, or the entry itself when its head opens nothing. `scroll`: bring it into view. */
function focusEntry(el: HTMLElement | undefined, scroll = true) {
  const target = el?.querySelector<HTMLElement>(":scope > .item-head[tabindex]") ?? el;
  if (!target) return;
  target.focus({ preventScroll: true });
  if (scroll) target.scrollIntoView({ block: "nearest" });
}

/** Focus goes on to the entry after those `leaving` (before them, at the end), so you carry on from where you were. */
function moveOn(leaving: string[], scroll: boolean) {
  const all = onPage();
  const gone = (el: HTMLElement) => leaving.includes(el.dataset.entry ?? "");
  const last = all.map(gone).lastIndexOf(true);
  if (last < 0) return;
  focusEntry(all.slice(last + 1).find((el) => !gone(el)) ?? all.slice(0, last).reverse().find((el) => !gone(el)), scroll);
}

/** Answers each card with what its employee recommends, one after another through `answer_card` as a tap does, and
 *  says what went. A card you answered yourself keeps that answer, even while you can still take it back. Resolves how
 *  many it answered. */
async function answerAll(cards: OpenCard[], who: string): Promise<number> {
  let sent = 0;
  for (const c of cards) {
    const reply = recommended(c.card);
    if (!reply || answering(c.run.id, c.index)) continue;
    try {
      await call("answer_card", { runId: c.run.id, card: c.index, answer: reply });
      sent++;
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  }
  // A run still asking something else holds these answers back until that is answered too. An answer on its way
  // counts as given, and news asks nothing.
  const left = [...new Set(cards.map((c) => c.run))]
    .reduce((n, run) => n + run.cards.filter((card, i) => isOpen(card) && !answering(run.id, i) && !cards.some((c) => c.run === run && c.index === i)).length, 0);
  if (sent) {
    toast(left ? `Noted. ${who} hears your answers once you answer ${left === 1 ? "the other question" : `the other ${left}`}.`
      : `Sent ${who} ${sent} ${sent === 1 ? "answer" : "answers"}.`, "ok");
  }
  return sent;
}

/**
 * Only what needs you: hire proposals, then Decisions, oldest waiting first (one entry per question, block, proposal or
 * breakage; one employee's choice cards about the same thing under one heading; runs that didn't finish on the same
 * error as one), then Replies, each conversation where it is your turn, newest first. Each is answered in place.
 * Snoozed holds what you put away until later, and Parked the cards you parked. The Archive holds everything else that
 * reached you, one line each, asking nothing, with what you archived, newest first by day. Who you are waiting on and
 * the week's numbers are on the Activity page. An entry opens in place into its whole thread. Keys (? lists them) act
 * on the focused entry only, never on one that is merely under the pointer, and while the pointer is over the list an
 * entry that leaves keeps its place, faded, so nothing moves under it.
 */
export function InboxScreen() {
  const { snap } = useOrg();
  const [view, setView] = useState<View>("inbox");
  const { items, ctx, error } = useStatuses();
  const archive = useQuery(() => (view === "archive" ? call("archived") : Promise.resolve(undefined)), [view], ["run:updated"]);
  const parked = useQuery(() => (view === "parked" ? call("parked_runs") : Promise.resolve(undefined)), [view], ["run:updated"]);
  const proposals = (useProposals() ?? []).filter((p) => p.state === "open");
  const shell = useShell();
  const [openId, setOpenId] = useState<string | null>(null);
  const [keys, setKeys] = useState(false);
  const keysAnchor = useRef<HTMLButtonElement>(null);
  // While the pointer is over the list, entries that leave it stay where they were until the pointer leaves: `shown`
  // is what the list last showed, `held` what has left it since. Focus moving on scrolls the list only when you work
  // it with keys (`byKeys`) or the pointer is elsewhere.
  const over = useRef(false);
  const shown = useRef(new Map<string, Decision<Item>>());
  const held = useRef(new Map<string, Decision<Item>>());
  const byKeys = useRef(false);
  const [, redraw] = useState(0);
  const employees = snap?.employees ?? [];
  const people = snap?.people ?? [];

  const live: Decision<Item>[] | null =
    view === "inbox" ? (items ? decisions(items.filter((i) => i.status.inbox)) : null)
    : view === "snoozed" ? (items ? decisions(items.filter((i) => i.status.state === "snoozed").sort((a, b) => a.status.snoozedUntil!.localeCompare(b.status.snoozedUntil!))) : null)
    : null;
  if (view === "inbox" && live) {
    const now = new Set(live.map((d) => d.id));
    if (over.current) for (const [id, d] of shown.current) if (!now.has(id)) held.current.set(id, d);
    for (const id of [...held.current.keys()]) if (now.has(id)) held.current.delete(id);
    shown.current = new Map(live.map((d) => [d.id, d]));
  }
  const entries = view === "inbox" && live ? [...live, ...held.current.values()] : live;
  const lists = view === "inbox" && entries ? inboxLists(entries) : null;
  const isHeld = (d: Decision<Item>) => held.current.has(d.id);
  const feed: Item[] | null =
    view === "archive" && snap && archive.data ? archive.data.flatMap((t: Thread) => toItem(t, snap, false, ctx) ?? []) : null;
  const loadError = view === "archive" ? archive.error : view === "parked" ? parked.error : error;
  const ids = lists
    ? [...lists.decisions.flatMap((x) => (x.type === "group" ? x.decisions : [x])), ...lists.replies].filter((d) => !isHeld(d)).map((d) => d.id)
    : entries?.map((d) => d.id) ?? feed?.map((i) => i.thread.root.id) ?? [];

  /** What an entry's buttons do. Archive and Later move an open entry on to the next, so you work down the list, and
   *  whatever settles an entry moves focus on to the next at once. Archive and Send & Archive act on the threads the
   *  entry is about; Later on their whole rows. */
  const actionsFor = (d: Decision<Item>): ItemActions => {
    const each = d.type === "failures" ? d.failures : [d];
    const rows = [...new Set(each.map((x) => x.item.thread.root.id))];
    const name = (run: Run) => firstName(employees.find((x) => x.id === run.employeeId)?.name ?? d.item.employee.name);
    const leaving = () => {
      const next = after(ids, d.id);
      return () => setOpenId((o) => (o === d.id ? next : o));
    };
    const settle = () => moveOn([d.id], byKeys.current || !over.current);
    return {
      done: async () => {
        const go = leaving();
        settle();
        if (await markDone(...each.filter((x) => archivable(x.thread, x.item.thread)).map((x) => x.thread.root.id))) go();
      },
      snooze: (until) => {
        const go = leaving();
        settle();
        for (const root of rows) setMark(root, { snoozedUntil: until.toISOString() });
        go();
      },
      wake: () => { for (const root of rows) setMark(root, { snoozedUntil: undefined }); },
      sendDone: async (text, attachments) => {
        const go = leaving();
        settle();
        await sendAndDone(d.thread.root.id, name(d.run), text, attachments);
        go();
      },
      // A run asking several things stays until its last card is answered. An answer still on its way counts, so the
      // last of several given quickly moves on too, and news asks nothing. Another's card under several questions
      // answers one of them at most, so they stay.
      answer: async (run, index, reply) => {
        const go = leaving();
        const last = (run === d.run || (d.type === "card" && d.cards.length === 1))
          && !run.cards.some((c, i) => i !== index && isOpen(c) && !answering(run.id, i));
        if (last) settle();
        if (await answerCard(run, index, reply, name(run)) && last) go();
      },
      answerAll: async (cards) => {
        const go = leaving();
        const last = d.type === "card" && d.cards.every((c) => !isOpen(c.card) || answering(c.run.id, c.index) || cards.includes(c));
        if (last) settle();
        if (await answerAll(cards, name(d.run)) === cards.length && last) go();
      },
    };
  };

  /** Approve all recommended on a group: focus goes past it, and each card gets its recommended choice. */
  const approve = async (g: Group<Item>, cards: OpenCard[]) => {
    moveOn(g.decisions.map((d) => d.id), byKeys.current || !over.current);
    await answerAll(cards, firstName(employees.find((x) => x.id === g.employeeId)?.name ?? "them"));
  };

  const reopenLine = (id: string) => {
    if (openId === id) setOpenId(null);
    void reopen(id);
  };

  // Keys act on the focused entry: J and K (or the arrows) move between entries, and A, 1 to 4, L, X and R press what
  // its card offers. E archives it, or in the Archive reopens it; Escape closes the open entry; ? lists the keys. An
  // entry merely under the pointer is never acted on. Z takes back your newest answer still waiting to go, wherever
  // it is.
  const latest = useRef({ entries, feed, view, actionsFor, reopenLine, openId });
  latest.current = { entries, feed, view, actionsFor, reopenLine, openId };
  useEffect(() => {
    const onPointer = () => { byKeys.current = false; };
    const onKey = (e: KeyboardEvent) => {
      byKeys.current = true;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || document.querySelector("[role=dialog]")) return;
      const { entries, feed, view, actionsFor, reopenLine, openId } = latest.current;
      const entry = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-entry]") : null;
      // The entry's own card, not one in the thread it opened into, nor another's asking the same with other choices.
      const head = entry?.querySelector<HTMLElement>(":scope > .item-head") ?? entry;
      const find = (selector: string) => head?.querySelector<HTMLElement>(`${selector}:not(.dec-others *)`);
      const press = (selector: string) => {
        const el = find(selector);
        el?.click();
        return !!el;
      };
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      switch (key) {
        case "j": case "k": case "ArrowDown": case "ArrowUp": {
          // Inside an entry's thread the arrows scroll it, as usual.
          if (key.startsWith("Arrow") && entry && document.activeElement !== entry && document.activeElement !== head) return;
          const all = onPage();
          const at = entry ? all.indexOf(entry) : -1;
          const to = at < 0 ? 0 : at + (key === "j" || key === "ArrowDown" ? 1 : -1);
          if (!all[to]) return;
          focusEntry(all[to]);
          break;
        }
        case "Escape":
          if (!openId) return;
          setOpenId(null);
          focusEntry(onPage().find((el) => el.dataset.entry === openId), false);
          return;
        case "a":
          if (!press("[data-card-recommended]") && !press("[data-answer-all]")) return;
          break;
        case "1": case "2": case "3": case "4":
          if (!press(`[data-card-choice="${Number(key) - 1}"]`)) return;
          break;
        case "l":
          if (!press("[data-card-later]") && !press("[data-later]")) return;
          break;
        case "x":
          if (!press("[data-card-no]")) return;
          break;
        case "z":
          if (!undoLatest()) return;
          break;
        case "r": {
          const reply = find("[data-card-reply]");
          if (!reply) return;
          reply.focus();
          break;
        }
        case "e": {
          const id = entry?.dataset.entry;
          if (view === "archive") {
            const i = feed?.find((x) => x.thread.root.id === id);
            if (!i || !wasArchived(i.thread)) return;
            reopenLine(i.thread.root.id);
            break;
          }
          const d = entries?.find((x) => x.id === id);
          if (!d || !doneable(d)) return;
          void actionsFor(d).done();
          break;
        }
        case "?":
          setKeys(true);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const showProposals = view === "inbox" && proposals.length > 0;
  const loaded = view === "archive" ? feed : view === "parked" ? parked.data : entries;
  const pick = (v: View) => {
    setView(v);
    setOpenId(null);
    over.current = false;
    held.current.clear();
  };
  const toggle = (id: string) => setOpenId((o) => (o === id ? null : id));
  const leave = () => {
    over.current = false;
    if (!held.current.size) return;
    held.current.clear();
    redraw((n) => n + 1);
  };
  const entry = (d: Decision<Item>) => (
    <DecisionItem
      key={d.id} d={d} employees={employees} people={people} actions={actionsFor(d)}
      open={openId === d.id} onToggle={() => toggle(d.id)} settled={isHeld(d)}
    />
  );
  const waiting = lists ? lists.decisions.flatMap((x) => (x.type === "group" ? x.decisions : [x])).filter((d) => !isHeld(d)).length : 0;

  return (
    <PageColumn
      title="Inbox"
      actions={
        <>
          <div className="seg" role="tablist" aria-label="Inbox, snoozed, parked or archive">
            {VIEWS.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} aria-pressed={view === v.id} onClick={() => pick(v.id)}>{v.label}</button>
            ))}
          </div>
          <button
            ref={keysAnchor} className="btn btn-ghost btn-sm btn-icon" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"
            aria-haspopup="dialog" aria-expanded={keys} onClick={() => setKeys((k) => !k)}
          >
            <Icon name="help" size={14} />
          </button>
          <Popover anchor={keysAnchor} open={keys} onClose={() => setKeys(false)} width={300}>
            <dl className="inbox-keys" aria-label="Keyboard shortcuts">
              {KEYS.map(([k, does], i) => <div key={i}><dt>{k}</dt><dd>{does}</dd></div>)}
            </dl>
          </Popover>
        </>
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
      {loadError ? <ErrorNote text={loadError} onRetry={view === "archive" ? archive.reload : view === "parked" ? parked.reload : undefined} /> : null}
      {!loaded && !loadError ? <div className="stack" style={{ gap: 8 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={56} r={10} />)}</div> : null}
      {view === "archive" && feed?.length === 0 ? <Empty view={view} /> : null}
      {view === "parked" && parked.data?.length === 0 ? <Empty view={view} /> : null}
      {view === "snoozed" && entries?.length === 0 ? <Empty view={view} /> : null}
      {view === "inbox" && entries?.length === 0 && !showProposals ? (
        <Section
          title="Needs you" count={null}
          action={<button className="btn btn-ghost btn-sm" onClick={() => pick("archive")}><Icon name="archive" size={13} /> Archive</button>}
        >
          <p className="inbox-clear">Nothing needs you right now.</p>
        </Section>
      ) : null}
      {lists && entries && entries.length > 0 ? (
        <div className="inbox-lists" onMouseEnter={() => { over.current = true; }} onMouseLeave={leave}>
          {lists.decisions.length ? (
            <Section title="Decisions" count={waiting}>
              <div className="inbox-list">
                {lists.decisions.map((x) => (x.type === "group" ? (
                  <DecisionGroup key={x.id} g={x} employees={employees} live={x.decisions.filter((d) => !isHeld(d))} onApprove={(cards) => approve(x, cards)}>
                    {x.decisions.map(entry)}
                  </DecisionGroup>
                ) : entry(x)))}
              </div>
            </Section>
          ) : null}
          {lists.replies.length ? (
            <Section title="Replies" count={lists.replies.filter((d) => !isHeld(d)).length}>
              <div className="inbox-list">{lists.replies.map(entry)}</div>
            </Section>
          ) : null}
        </div>
      ) : null}
      {view === "snoozed" && entries && entries.length > 0 ? (
        <Section title="Snoozed" count={entries.length}>
          <div className="inbox-list">{entries.map(entry)}</div>
        </Section>
      ) : null}

      {view === "parked" && parked.data && parked.data.length > 0 ? (
        <Section title="Parked" count={parked.data.length}>
          <div className="inbox-list">
            {parked.data.map((r) => <ParkedItem key={r.id} run={r} employees={employees} people={people} />)}
          </div>
        </Section>
      ) : null}

      {feed && feed.length > 0 ? (
        <Section title="Archived" count={null}>
          <div className="inbox-list">
            {byDay(feed).map((g) => (
              <div key={g.day} className="inbox-group">
                <div className="inbox-day">{g.day}</div>
                {g.items.map((i) => {
                  const id = i.thread.root.id;
                  return (
                    <FeedItem
                      key={id} item={i} employees={employees} people={people} open={openId === id} onToggle={() => toggle(id)}
                      onReopen={wasArchived(i.thread) ? () => reopenLine(id) : null}
                    />
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

/** What an empty Snoozed, Parked or Archive says. */
function Empty({ view }: { view: "snoozed" | "parked" | "archive" }) {
  const [icon, title, text] =
    view === "snoozed" ? ["clock", "Nothing snoozed", "Later puts an entry away until a time you pick, and it comes back to your Inbox then."] as const
    : view === "parked" ? ["layers", "Nothing parked", "Cards you park wait here, without reminding you, until you answer them."] as const
    : ["archive", "Nothing in the Archive", "Everything that reaches you and needs nothing from you lands here, with what you archive. If it needs you again, it comes back to your Inbox."] as const;
  return (
    <div className="empty">
      <Icon name={icon} size={22} />
      <span className="empty-title">{title}</span>
      <p>{text}</p>
    </div>
  );
}
