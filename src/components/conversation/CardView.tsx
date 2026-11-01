import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { call, errorMessage } from "../../api/client";
import type { Card, CardAnswer, CardItem, CardReply, EmployeeView, Proposal, Run } from "../../api/types";
import { firstName, MOD, whenInline } from "../../lib/format";
import { useQuery } from "../../lib/hooks";
import { createStore, useStore } from "../../lib/store";
import { isLive, isOpen } from "../../lib/threads";
import { toast } from "../../lib/toasts";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";
import { CardImages } from "./CardImages";
import { CardLink, openWeb, webUrl } from "./CardLink";
import { LaterMenu } from "./LaterMenu";
import "../../screens/Inbox.css";

/** How long an answer waits, with Undo, before it goes. */
export const UNDO_MS = 4000;
/** What Summarise asks. A question answers nothing, so the card stays open. */
const SUMMARISE = "Summarise this in three short lines: what it is, what changes, and what you recommend.";

/** An answer you gave on a card (`index` in run `runId`'s cards), from when you give it until a little after it went.
 *  said: the answer in a few words, "Merge". going: it went, or is going, so Undo no longer takes it back. */
export type PendingAnswer = { runId: string; index: number; said: string; going: boolean };
const pending = createStore<PendingAnswer[]>([]);
/** Takes back each answer still waiting to go, by `runId:index`. */
const undos = new Map<string, () => void>();
const onCard = (runId: string, index: number) => (p: PendingAnswer) => p.runId === runId && p.index === index;

/** Every answer on its way, oldest first. */
export const usePendingAnswers = () => useStore(pending);

/** An answer on the card at `index` of run `runId`'s cards is on its way. */
export const answering = (runId: string, index: number): boolean => pending.get().some(onCard(runId, index));

/** Takes back an answer that has not gone yet, so its card is open again. */
export function undoAnswer(runId: string, index: number) {
  undos.get(`${runId}:${index}`)?.();
}

/** Takes back the newest answer that has not gone yet. False when none is waiting to go. */
export function undoLatest(): boolean {
  const p = pending.get().filter((x) => !x.going).pop();
  if (p) undoAnswer(p.runId, p.index);
  return !!p;
}

/** Your answer on the card at `index` of `run`'s cards. It waits `UNDO_MS`, shown as on its way with Undo, then goes,
 *  and says what went. Resolves true once it went; false when you took it back, or when it failed, having said why. */
export async function answerCard(run: Run, index: number, reply: CardReply, name: string): Promise<boolean> {
  const mine = onCard(run.id, index);
  if (pending.get().some(mine)) return false;
  const card = run.cards[index];
  const key = `${run.id}:${index}`;
  const forget = () => pending.set(pending.get().filter((p) => !mine(p)));
  pending.set([...pending.get(), { runId: run.id, index, said: saying(card, reply), going: false }]);
  const go = await new Promise<boolean>((done) => {
    const timer = window.setTimeout(() => done(true), UNDO_MS);
    undos.set(key, () => { window.clearTimeout(timer); done(false); });
  });
  undos.delete(key);
  if (!go) {
    forget();
    return false;
  }
  pending.set(pending.get().map((p) => (mine(p) ? { ...p, going: true } : p)));
  // The run holds this answer back while it asks something you have not answered, and hears them all at once.
  // Cards you answered since `run` was read are on their way, so they do not count, and news asks nothing.
  const rest = run.cards.filter((c, i) => i !== index && isOpen(c) && !answering(run.id, i)).length;
  let replies: Run[];
  try {
    replies = await call("answer_card", { runId: run.id, card: index, answer: reply });
  } catch (err) {
    forget();
    toast(errorMessage(err), "err");
    return false;
  }
  // Listed a little longer: runs read before it went still show the card open, so the card goes on showing it on its
  // way, and the run's other answers still count it as answered.
  window.setTimeout(forget, UNDO_MS + 1000);
  // News sends nothing, so there is nothing to say.
  if (reply.type === "seen") return true;
  if (rest) {
    toast(`Noted. ${name} hears your answers once you answer ${rest === 1 ? "the other question" : `the other ${rest}`}.`, "ok");
    return true;
  }
  const ask = card?.ask;
  const to = replies.length > 1 ? `${name} and ${replies.length - 1} more` : name;
  const said =
    reply.type === "choice" ? `Sent to ${to}: ${ask?.type === "choices" ? ask.choices[reply.index] : ""}.`
    : reply.type === "items" || reply.type === "text" ? `Sent to ${to}.`
    : reply.type === "done" ? (replies.length > 1 ? `Done. ${replies.length} runs carry on.` : `Done. ${name} carries on.`)
    : reply.type === "cant" ? `Sent to ${to}: you can't do it.`
    : reply.type === "reject" ? `No. ${name} drops it.`
    : reply.type === "later" ? (card?.timesBack ? "Parked. It won't come back by itself." : `Later. It comes back ${whenInline(reply.until)}.`)
    : ask?.type === "chore" ? "Not now."
    : `Not now. ${name} brings it back tomorrow.`;
  toast(said, "ok");
  return true;
}

/** The day a card you put off comes back, "Mon, 2 Nov". */
const backDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** Your answer in a few words, as the card shows it on its way: "Merge", "Post 2", "Later (Mon, 2 Nov)". */
function saying(card: Card | undefined, reply: CardReply): string {
  const ask = card?.ask;
  switch (reply.type) {
    case "choice": return ask?.type === "choices" ? ask.choices[reply.index] ?? "" : "";
    case "items": {
      const ticked = reply.picks.filter((p) => p.tick).length;
      return ticked && ask?.type === "items" ? `${ask.verb} ${ticked}` : "Notes";
    }
    case "done": return "I've done it";
    case "cant": return "Can't";
    case "seen": return "Got it";
    case "dismiss": return "Not now";
    case "reject": return ask?.type === "items" ? `Don't ${ask.verb.toLowerCase()}` : "No";
    case "later": return card?.timesBack ? "Later (parks it)" : `Later (${backDay(reply.until)})`;
    case "text":
    case "ask": return `"${reply.text}"`;
  }
}

/** What became of an answered card, as one line. */
function answered(c: Card, a: CardAnswer): string {
  const tail = a.held ? ". Sends when the rest are answered." : "";
  if (c.parked) return `Parked${tail}`;
  // Put off to a day still ahead when you answered: Later, not an answer given once it came back.
  if (c.backAt && Date.parse(c.backAt) > Date.parse(a.at)) return `Later: back on ${backDay(c.backAt)}${tail}`;
  if (c.ask.type === "news") return "Got it";
  switch (a.how) {
    case "tapped": return a.held ? `${a.text} Sends when the rest are answered.` : `Sent: ${a.text}`;
    // A dismissed chore sends nothing and does not come back.
    case "dismissed": return `Not now${a.text ? " (back in a day)" : ""}${tail}`;
    case "rejected": return `${c.ask.type === "task" ? "Can't" : "No"}${tail}`;
    case "replaced": return "A newer card replaced this one";
    case "typed": return a.held ? `"${a.text}" Sends when the rest are answered.` : `Sent: "${a.text}"`;
    case "withdrawn": return a.text ? `Withdrawn: ${a.text}` : "They withdrew it";
  }
}

/** A run's cards, each with its question and the answer built in, as a thread shows them. */
export function RunCards({ run, e }: { run: Run; e: EmployeeView }) {
  const name = firstName(e.name);
  return <CardList runId={run.id} cards={run.cards.map((card, index) => ({ card, index }))} e={e} working={isLive(run)} onAnswer={async (i, reply) => { await answerCard(run, i, reply, name); }} />;
}

/** Cards of run `runId`, each with its question and the answer built in. `index`: the card's place in the run's cards.
 *  `working`: the run is still working, so they take no answer yet. */
export function CardList({ runId, cards, e, working, onAnswer }: {
  runId: string;
  cards: { card: Card; index: number }[];
  e: EmployeeView;
  working: boolean;
  onAnswer: (index: number, reply: CardReply) => Promise<void>;
}) {
  return cards.map(({ card: c, index }) => (
    <div key={index} className="card-ask">
      <div className="card-q">{c.message}</div>
      {c.why ? <div className="card-why">{c.why}</div> : null}
      <CardView card={c} runId={runId} index={index} e={e} working={working} onAnswer={(reply) => onAnswer(index, reply)} />
    </div>
  ));
}

/** A card's answer built in, under the link, images, proposal and file it is about if it has them: buttons for a
 *  decision, a tick list, I've done it for a to-do or a chore, your own words for a question, or Got it for news. Under
 *  most, a line for your own words or a question. An answer shows as on its way, with Undo, until it goes; once
 *  answered, one line on what you did. `index`: its place in run `runId`'s cards. `working`: the run is still working,
 *  so the card takes no answer until it finishes. */
export function CardView({ card, runId, index, e, working, onAnswer }: {
  card: Card;
  runId: string;
  index: number;
  e: EmployeeView;
  working: boolean;
  onAnswer: (reply: CardReply) => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  // Your words on the reply line, kept here so Undo gives them back.
  const [text, setText] = useState("");
  const going = usePendingAnswers().find(onCard(runId, index));
  // A parked card stays answerable: its Not now is only a placeholder until you decide.
  if (card.answer && !card.parked) return <p className="card-answered">{card.answer.held ? <Icon name="check" size={12} /> : null}{answered(card, card.answer)}</p>;
  if (going) return <Sending p={going} />;
  const name = firstName(e.name);
  const ask = card.ask;
  const busy = sending || working;
  const send = async (reply: CardReply) => {
    setSending(true);
    try { await onAnswer(reply); } finally { setSending(false); }
  };
  /** A question answers nothing, so it goes straight to them and the card stays where it is. */
  const askAbout = async (text: string): Promise<boolean> => {
    setSending(true);
    try {
      await call("answer_card", { runId, card: index, answer: { type: "ask", text } });
      toast(`Asked ${name}. The card stays open until you answer it.`, "ok");
      return true;
    } catch (err) {
      toast(errorMessage(err), "err");
      return false;
    } finally {
      setSending(false);
    }
  };
  // A parked card had its Later: it takes any other answer.
  const later = card.parked ? null : <LaterMenu timesBack={card.timesBack} disabled={busy} onLater={(until) => void send({ type: "later", until: until.toISOString() })} />;
  /** Later, and No in the card's own words. */
  const decline = (no: string) => (
    <>
      {later}
      <button className="btn btn-ghost btn-sm" data-card-no title="They drop it and don't ask again" disabled={busy} onClick={() => void send({ type: "reject" })}>
        {no}
      </button>
    </>
  );
  // The page a to-do or a chore is done on, opened in your browser: the first step until you have done it.
  const url = ask.type === "task" || ask.type === "chore" ? webUrl(ask.url) : null;
  const open = (label: string) => url ? (
    <button className="btn btn-primary btn-sm" title={url.href} onClick={() => openWeb(url)}><Icon name="external" size={12} /> {label}</button>
  ) : null;
  const did = (title: string) => (
    <button className={`btn btn-sm ${url ? "" : "btn-primary"}`} title={title} disabled={busy} data-card-recommended onClick={() => void send({ type: "done" })}>
      <Icon name="check" size={13} /> I've done it
    </button>
  );
  const words = (hint: string) => (
    <CardText name={name} hint={hint} text={text} setText={setText} sending={busy} onText={(t) => void send({ type: "text", text: t })} onAsk={askAbout} />
  );
  const answer = (): ReactNode => {
    switch (ask.type) {
      case "choices": return (
        <div className="card-choices">
          {ask.choices.map((c, i) => (
            <button
              key={i} className={`btn btn-sm ${i === ask.recommended ? "btn-primary" : ""}`} disabled={busy}
              data-card-choice={i} data-card-recommended={i === ask.recommended || undefined} onClick={() => void send({ type: "choice", index: i })}
            >
              {c}{i === ask.recommended ? <span className="card-rec">Recommended</span> : null}
            </button>
          ))}
          {decline("No")}
        </div>
      );
      case "items": return <ItemsCard verb={ask.verb} items={ask.items} name={name} sending={busy} send={send} decline={decline(`Don't ${ask.verb.toLowerCase()}`)} />;
      case "task": return (
        <>
          {ask.steps.trim() ? <p className="card-steps">{ask.steps.trim()}</p> : null}
          <div className="card-choices">
            {open("Open")}
            {did(`Tells ${name} you did it`)}
            <button className="btn btn-ghost btn-sm" title={`Tells ${name} you can't do it`} disabled={busy} data-card-no onClick={() => void send({ type: "cant" })}>Can't</button>
            {later}
          </div>
        </>
      );
      // Your answer is the reply line, so it comes first.
      case "question": return <>{words("Your answer")}{later ? <div className="card-choices">{later}</div> : null}</>;
      case "news": return (
        <div className="card-choices">
          <button className="btn btn-primary btn-sm" disabled={busy} data-card-recommended onClick={() => void send({ type: "seen" })}><Icon name="check" size={13} /> Got it</button>
        </div>
      );
      case "chore": return (
        <div className="card-choices">
          {open(ask.subject.startsWith("sign-in:") ? "Open sign-in page" : "Open")}
          {did("You did it. Every run waiting on this carries on.")}
          <button className="btn btn-ghost btn-sm" title="Sends nothing, and it doesn't come back" disabled={busy} data-card-no onClick={() => void send({ type: "dismiss" })}>Not now</button>
        </div>
      );
    }
  };
  const link = webUrl(card.link);
  const proposal = card.proposal;
  return (
    <div onClick={(ev) => ev.stopPropagation()}>
      {link || card.images.length ? (
        <div className="card-about">
          {link ? <CardLink url={link} /> : null}
          {card.images.length ? <CardImages paths={card.images.slice(0, 3)} /> : null}
        </div>
      ) : null}
      {proposal?.type === "companyLine" ? (
        <div className="card-proposal">
          <p className="card-proposal-head">Adds to the company page under <b>{proposal.section}</b>:</p>
          <p className="card-proposal-line">{proposal.line}</p>
        </div>
      ) : null}
      {card.file ? <CardFile runId={runId} index={index} path={card.file} label={proposedVersion(proposal, name)} /> : null}
      {working ? <p className="card-wait">Waiting for {name} to finish</p> : null}
      {answer()}
      {ask.type === "question" || ask.type === "news" ? null : words(`Answer in your own words, or ask ${name} about it`)}
    </div>
  );
}

/** What a proposal's file holds, as its label: the version it proposes. */
function proposedVersion(p: Proposal | null, name: string): string | undefined {
  return p?.type === "owns" ? `Proposed version of what ${name} owns` : p?.type === "companyPage" ? "Proposed version of the company page" : undefined;
}

/** An answer on its way, in place of the card's buttons, with Undo until it goes. */
function Sending({ p }: { p: PendingAnswer }) {
  return (
    <p className="card-answered card-sending" role="status">
      <span className="card-sending-said">Sending: {p.said}</span>
      {p.going ? null : (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="card-undo" aria-label={`Undo ${p.said}`} onClick={() => undoAnswer(p.runId, p.index)}>Undo</button>
        </>
      )}
    </p>
  );
}

/** A line under an open card: Enter answers it in your own words, this card only. Ask sends the words as a question,
 *  and Summarise asks for the card in three short lines; either way the card stays open for your answer. */
function CardText({ name, hint, text, setText, sending, onText, onAsk }: {
  name: string;
  /** What the line is for, as its placeholder and label. */
  hint: string;
  text: string;
  setText: (text: string) => void;
  sending: boolean;
  onText: (text: string) => void;
  /** Resolves whether the question went. */
  onAsk: (text: string) => Promise<boolean>;
}) {
  const said = text.trim();
  return (
    <div className="card-text">
      <input
        className="input" value={text} disabled={sending} placeholder={hint} aria-label={hint} data-card-reply
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={(ev) => { if (ev.key === "Enter" && !ev.nativeEvent.isComposing && said) { ev.preventDefault(); onText(said); } }}
      />
      <button className="btn btn-ghost btn-sm" disabled={sending || !said} title="Sends it as a question. The card stays open." onClick={async () => { if (await onAsk(said)) setText(""); }}>
        <Icon name="ask" size={13} /> Ask
      </button>
      <button className="btn btn-ghost btn-sm" disabled={sending} title={`${name} sums it up in three short lines. The card stays open.`} onClick={() => void onAsk(SUMMARISE)}>
        <Icon name="sparkle" size={13} /> Summarise
      </button>
    </div>
  );
}

/** The file a card is about, e.g. a draft, read as it is now so you see what would go out: its first lines, and the
 *  rest on Show all. Read again whenever a run changes, so a draft the employee reworked shows the new version.
 *  `label`: what it is, in place of its name, such as the version a proposal would put in place. */
function CardFile({ runId, index, path, label }: { runId: string; index: number; path: string; label?: string }) {
  const file = useQuery(() => call("card_file", { runId, card: index }), [runId, index, path], ["run:updated"]);
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (body.current && !all) setLong(body.current.scrollHeight > body.current.clientHeight + 1);
  }, [file.data, all]);
  const open = () => call("open_report_path", { path }).catch((err) => toast(errorMessage(err), "err"));
  return (
    <div className="card-file">
      <div className="card-file-head">
        <Icon name="file" size={13} />
        <span className={label ? "card-file-label" : "card-file-name"} title={path}>{label ?? path.split("/").pop()}</span>
        <span className="grow" />
        <button className="btn btn-ghost btn-sm" title="Open in its app" onClick={() => void open()}><Icon name="external" size={12} /> Open</button>
      </div>
      {file.error ? <p className="card-file-note">{file.error}</p> : file.data === undefined ? null : (
        <>
          <div ref={body} className={`card-file-body ${all ? "" : "card-file-clip"} ${long && !all ? "card-file-fade" : ""}`}>
            {/\.txt$/i.test(path) ? <pre className="card-file-text">{file.data}</pre> : <Markdown text={file.data} breaks />}
          </div>
          {long ? <button className="btn btn-ghost btn-sm card-file-more" onClick={() => setAll(!all)}>{all ? "Show less" : "Show all"}</button> : null}
        </>
      )}
    </div>
  );
}

/** A list to approve one by one, what the employee recommends ticked already: a note on any item, then Send.
 *  On a focused item, arrows move, Space ticks, Enter shows it all and N adds a note; Cmd or Ctrl + Enter sends. */
function ItemsCard({ verb, items, name, sending, send, decline }: {
  verb: string;
  items: CardItem[];
  name: string;
  sending: boolean;
  send: (reply: CardReply) => Promise<void>;
  decline: ReactNode;
}) {
  const [ticks, setTicks] = useState<Record<string, boolean>>(() => Object.fromEntries(items.map((i) => [i.id, i.recommended])));
  const [touched, setTouched] = useState(false);
  const [notes, setNotes] = useState<Record<string, string | undefined>>({});
  const list = useRef<HTMLUListElement>(null);
  const ticked = items.filter((i) => ticks[i.id]).length;
  const noted = items.some((i) => notes[i.id]?.trim());
  const ready = !sending && (ticked > 0 || noted);
  const go = () => {
    if (ready) void send({ type: "items", picks: items.map((i) => ({ id: i.id, tick: !!ticks[i.id], note: notes[i.id]?.trim() || null })) });
  };
  return (
    <div className="card-items" onKeyDown={(ev) => { if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); go(); } }}>
      <ul ref={list}>
        {items.map((i, n) => (
          <ItemRow
            key={i.id} item={i} verb={verb} name={name} sending={sending} ticked={!!ticks[i.id]} note={notes[i.id]}
            onTick={() => { setTicks((t) => ({ ...t, [i.id]: !t[i.id] })); setTouched(true); }}
            onNote={(note) => setNotes((x) => ({ ...x, [i.id]: note }))}
            onMove={(by) => (list.current?.children[n + by] as HTMLElement | undefined)?.focus()}
          />
        ))}
      </ul>
      <div className="card-items-foot">
        <span className="faint grow">{touched || !items.some((i) => i.recommended) ? `${ticked} of ${items.length} ticked` : `${name}'s picks are ticked`}</span>
        {decline}
        <button className="btn btn-primary btn-sm" disabled={!ready} data-card-recommended onClick={go}>
          {ticked ? `${verb} ${ticked}` : noted ? "Send notes" : verb}<span className="card-kbd">{MOD} ↵</span>
        </button>
      </div>
    </div>
  );
}

/** One item: its id and what it is about, then the text that would go out, three lines until Show all. Note shows
 *  on hover or focus. `note`: undefined until you add one. */
function ItemRow({ item, verb, name, sending, ticked, note, onTick, onNote, onMove }: {
  item: CardItem;
  verb: string;
  name: string;
  sending: boolean;
  ticked: boolean;
  note: string | undefined;
  onTick: () => void;
  onNote: (note: string | undefined) => void;
  onMove: (by: 1 | -1) => void;
}) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState({ about: false, text: false });
  const row = useRef<HTMLLIElement>(null);
  const about = useRef<HTMLParagraphElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const noteInput = useRef<HTMLInputElement>(null);
  // Measured while closed, so an open item keeps its Show less.
  useLayoutEffect(() => {
    const over = (el: HTMLElement | null) => !!el && el.scrollHeight > el.clientHeight + 1;
    if (!open) setClipped({ about: over(about.current), text: over(text.current) });
  }, [item.about, item.text, open]);
  const long = clipped.about || clipped.text;
  const expand = () => { if (long && !open) setOpen(true); };
  const onKey = (ev: KeyboardEvent<HTMLLIElement>) => {
    if (ev.target !== ev.currentTarget || ev.metaKey || ev.ctrlKey || ev.altKey || sending) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") onMove(ev.key === "ArrowDown" ? 1 : -1);
    else if (ev.key === " ") onTick();
    else if (ev.key === "Enter" && long) setOpen(!open);
    else if (ev.key.toLowerCase() === "n") { if (note === undefined) onNote(""); else noteInput.current?.focus(); }
    else return;
    ev.preventDefault();
  };
  return (
    <li ref={row} className={`card-item ${ticked ? "card-item-on" : ""} ${open ? "card-item-open" : ""}`} tabIndex={0} onKeyDown={onKey}>
      <input type="checkbox" tabIndex={-1} checked={ticked} disabled={sending} aria-label={`${verb} ${item.id}`} onChange={onTick} />
      <div className="card-item-main">
        <p ref={about} className="card-item-about" onClick={expand}><b>{item.id}</b>{item.about}</p>
        <div ref={text} className={`card-item-text ${clipped.text && !open ? "card-item-fade" : ""}`} onClick={expand}>{item.text}</div>
        {long ? (
          <button className="card-item-more" tabIndex={-1} onClick={() => setOpen(!open)}>
            {open ? "Show less" : "Show all"} <Icon name="chevronDown" size={12} />
          </button>
        ) : null}
        {note !== undefined ? (
          <input
            ref={noteInput} className="input" autoFocus maxLength={300} placeholder={`Note for ${name} (optional)`} value={note} disabled={sending}
            onChange={(ev) => onNote(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === "Escape" && !note) { ev.preventDefault(); onNote(undefined); row.current?.focus(); } }}
          />
        ) : null}
      </div>
      {note === undefined ? <button className="btn btn-ghost btn-sm card-item-note" tabIndex={-1} disabled={sending} onClick={() => onNote("")}>Note</button> : null}
    </li>
  );
}
