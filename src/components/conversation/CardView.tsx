import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { call, errorMessage } from "../../api/client";
import type { Card, CardAnswer, CardItem, CardReply, EmployeeView, Run } from "../../api/types";
import { firstName } from "../../lib/format";
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
    : reply.type === "items" ? `Sent to ${to}.`
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
    case "typed": return "You answered in the thread";
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
 *  if it has one. Once answered, one line on what you did. `index`: its place in run `runId`'s cards. */
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
  const decline = (
    <>
      <button className="btn btn-ghost btn-sm" title="Busy, not a no: they bring it back tomorrow" disabled={sending} onClick={() => void send({ type: "dismiss" })}>
        Not now
      </button>
      <button className="btn btn-ghost btn-sm" title="They drop it and don't ask again" disabled={sending} onClick={() => void send({ type: "reject" })}>
        No
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
          {decline}
        </div>
      ) : ask.type === "items" ? (
        <ItemsCard verb={ask.verb} items={ask.items} name={name} sending={sending} send={send} decline={decline} />
      ) : (
        <div className="card-choices">
          <button className="btn btn-primary btn-sm" title="You did it. Every run waiting on this carries on." disabled={sending} onClick={() => void send({ type: "done" })}>
            <Icon name="check" size={13} /> Done
          </button>
          <button className="btn btn-ghost btn-sm" disabled={sending} onClick={() => void send({ type: "dismiss" })}>Not now</button>
        </div>
      )}
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

/** A list to approve one by one: a tick and an optional note per item, then Send. */
function ItemsCard({ verb, items, name, sending, send, decline }: {
  verb: string;
  items: CardItem[];
  name: string;
  sending: boolean;
  send: (reply: CardReply) => Promise<void>;
  decline: ReactNode;
}) {
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string | undefined>>({});
  const ticked = items.filter((i) => ticks[i.id]).length;
  const ready = ticked > 0 || items.some((i) => notes[i.id]?.trim());
  const picks = items.map((i) => ({ id: i.id, tick: !!ticks[i.id], note: notes[i.id]?.trim() || null }));
  return (
    <div className="card-items">
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <div className="card-item">
              <label>
                <input
                  type="checkbox" checked={!!ticks[i.id]} disabled={sending} title={`${verb} ${i.id}`}
                  onChange={(ev) => setTicks((t) => ({ ...t, [i.id]: ev.target.checked }))}
                />
                <b>{i.id}</b>
                <span>{i.text}</span>
                {i.recommended ? <span className="card-rec">Recommended</span> : null}
              </label>
              {notes[i.id] === undefined ? (
                <button className="btn btn-ghost btn-sm" disabled={sending} onClick={() => setNotes((n) => ({ ...n, [i.id]: "" }))}>Note</button>
              ) : null}
            </div>
            {notes[i.id] !== undefined ? (
              <input
                className="input" autoFocus maxLength={300} placeholder={`Note for ${name} (optional)`} value={notes[i.id]} disabled={sending}
                onChange={(ev) => setNotes((n) => ({ ...n, [i.id]: ev.target.value }))}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <div className="card-items-foot">
        <span className="faint">{ticked} of {items.length} ticked</span>
        <span className="grow" />
        {decline}
        <button className="btn btn-primary btn-sm" disabled={sending || !ready} onClick={() => void send({ type: "items", picks })}>Send</button>
      </div>
    </div>
  );
}
