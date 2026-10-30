import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { call, errorMessage } from "../../api/client";
import type { Card, CardAnswer, CardItem, CardReply, EmployeeView, Run } from "../../api/types";
import { firstName, MOD } from "../../lib/format";
import { useQuery } from "../../lib/hooks";
import { toast } from "../../lib/toasts";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";
import "../../screens/Inbox.css";

/** Sends your answer on the card at `index` of `run`'s cards and says what went. Resolves false, having said why,
 *  when it failed. */
export async function answerCard(run: Run, index: number, reply: CardReply, name: string): Promise<boolean> {
  let replies: Run[];
  try {
    replies = await call("answer_card", { runId: run.id, card: index, answer: reply });
  } catch (err) {
    toast(errorMessage(err), "err");
    return false;
  }
  const ask = run.cards[index]?.ask;
  // The run still asks something else, so it holds this answer back and hears them all at once.
  const rest = run.cards.filter((c, i) => i !== index && !c.answer).length;
  if (rest) {
    toast(`Noted. ${name} hears your answers once you answer ${rest === 1 ? "the other question" : `the other ${rest}`}.`, "ok");
    return true;
  }
  const to = replies.length > 1 ? `${name} and ${replies.length - 1} more` : name;
  const said =
    reply.type === "choice" ? `Sent to ${to}: ${ask?.type === "choices" ? ask.choices[reply.index] : ""}.`
    : reply.type === "items" || reply.type === "text" ? `Sent to ${to}.`
    : reply.type === "done" ? (replies.length > 1 ? `Done. ${replies.length} runs carry on.` : `Done. ${name} carries on.`)
    : reply.type === "reject" ? `No. ${name} drops it.`
    : ask?.type === "chore" ? "Not now."
    : `Not now. ${name} brings it back tomorrow.`;
  toast(said, "ok");
  return true;
}

/** What became of an answered card, as one line. */
function answered(a: CardAnswer): string {
  switch (a.how) {
    case "tapped": return a.held ? `${a.text} Sends when the rest are answered.` : `Sent: ${a.text}`;
    // A dismissed chore sends nothing and does not come back.
    case "dismissed": return `Not now${a.text ? " (back in a day)" : ""}${a.held ? ". Sends when the rest are answered." : ""}`;
    case "rejected": return a.held ? "No. Sends when the rest are answered." : "No";
    case "replaced": return "A newer card replaced this one";
    case "typed": return a.held ? `"${a.text}" Sends when the rest are answered.` : `Sent: "${a.text}"`;
    case "withdrawn": return a.text ? `Withdrawn: ${a.text}` : "They withdrew it";
  }
}

/** A run's cards, each with its question and the answer built in, as a thread shows them. */
export function RunCards({ run, e }: { run: Run; e: EmployeeView }) {
  const name = firstName(e.name);
  return <CardList runId={run.id} cards={run.cards.map((card, index) => ({ card, index }))} e={e} onAnswer={async (i, reply) => { await answerCard(run, i, reply, name); }} />;
}

/** Cards of run `runId`, each with its question and the answer built in. `index`: the card's place in the run's cards. */
export function CardList({ runId, cards, e, onAnswer }: {
  runId: string;
  cards: { card: Card; index: number }[];
  e: EmployeeView;
  onAnswer: (index: number, reply: CardReply) => Promise<void>;
}) {
  return cards.map(({ card: c, index }) => (
    <div key={index} className="card-ask">
      <div className="card-q">{c.message}</div>
      {c.why ? <div className="card-why">{c.why}</div> : null}
      <CardView card={c} runId={runId} index={index} e={e} onAnswer={(reply) => onAnswer(index, reply)} />
    </div>
  ));
}

/** A card's answer built in: buttons for a decision, a tick list, or Done for a chore, under the file it is about
 *  if it has one, and a line for your own words or a question. Once answered, one line on what you did. `index`: its
 *  place in run `runId`'s cards. */
export function CardView({ card, runId, index, e, onAnswer }: {
  card: Card;
  runId: string;
  index: number;
  e: EmployeeView;
  onAnswer: (reply: CardReply) => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  if (card.answer) return <p className="card-answered">{card.answer.held ? <Icon name="check" size={12} /> : null}{answered(card.answer)}</p>;
  const name = firstName(e.name);
  const ask = card.ask;
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
  /** Not now, and No in the card's own words. */
  const decline = (no: string) => (
    <>
      <button className="btn btn-ghost btn-sm" title="Busy, not a no: they bring it back tomorrow" disabled={sending} onClick={() => void send({ type: "dismiss" })}>
        Not now
      </button>
      <button className="btn btn-ghost btn-sm" title="They drop it and don't ask again" disabled={sending} onClick={() => void send({ type: "reject" })}>
        {no}
      </button>
    </>
  );
  return (
    <div onClick={(ev) => ev.stopPropagation()}>
      {card.file ? <CardFile runId={runId} index={index} path={card.file} /> : null}
      {ask.type === "choices" ? (
        <div className="card-choices">
          {ask.choices.map((c, i) => (
            <button key={i} className={`btn btn-sm ${i === ask.recommended ? "btn-primary" : ""}`} disabled={sending} onClick={() => void send({ type: "choice", index: i })}>
              {c}{i === ask.recommended ? <span className="card-rec">Recommended</span> : null}
            </button>
          ))}
          {decline("No")}
        </div>
      ) : ask.type === "items" ? (
        <ItemsCard verb={ask.verb} items={ask.items} name={name} sending={sending} send={send} decline={decline(`Don't ${ask.verb.toLowerCase()}`)} />
      ) : (
        <div className="card-choices">
          <button className="btn btn-primary btn-sm" title="You did it. Every run waiting on this carries on." disabled={sending} onClick={() => void send({ type: "done" })}>
            <Icon name="check" size={13} /> Done
          </button>
          <button className="btn btn-ghost btn-sm" disabled={sending} onClick={() => void send({ type: "dismiss" })}>Not now</button>
        </div>
      )}
      <CardText name={name} sending={sending} onText={(text) => void send({ type: "text", text })} onAsk={askAbout} />
    </div>
  );
}

/** A line under an open card: Enter answers it in your own words, this card only; Ask sends the words as a question,
 *  and the card stays open for your answer. */
function CardText({ name, sending, onText, onAsk }: {
  name: string;
  sending: boolean;
  onText: (text: string) => void;
  /** Resolves whether the question went. */
  onAsk: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const said = text.trim();
  const hint = `Answer in your own words, or ask ${name} about it`;
  return (
    <div className="card-text">
      <input
        className="input" value={text} disabled={sending} placeholder={hint} aria-label={hint}
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={(ev) => { if (ev.key === "Enter" && !ev.nativeEvent.isComposing && said) { ev.preventDefault(); onText(said); } }}
      />
      <button className="btn btn-ghost btn-sm" disabled={sending || !said} title="Sends it as a question. The card stays open." onClick={async () => { if (await onAsk(said)) setText(""); }}>
        <Icon name="ask" size={13} /> Ask
      </button>
    </div>
  );
}

/** The file a card is about, e.g. a draft, read as it is now so you see what would go out: its first lines, and the
 *  rest on Show all. Read again whenever a run changes, so a draft the employee reworked shows the new version. */
function CardFile({ runId, index, path }: { runId: string; index: number; path: string }) {
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
        <span className="card-file-name" title={path}>{path.split("/").pop()}</span>
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
        <button className="btn btn-primary btn-sm" disabled={!ready} onClick={go}>
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
