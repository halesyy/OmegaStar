// Quick ask: the small box the shortcut opens over any app (src-tauri/src/quick_ask.rs). One field: @ someone,
// say what you need, Enter sends it to them as a new conversation, the same as from their chat. Esc puts it away.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { call, errorMessage } from "../api/client";
import { Avatar } from "../components/ui";
import { firstName } from "../lib/format";
import { useOrg } from "../lib/hooks";
import { mentionAt, mentionMatches, namedPieces, pickMention, recipient } from "../lib/quickAsk";
import "./QuickAsk.css";

const inTauri = "__TAURI_INTERNALS__" in window;
/** The box's width; its height follows what it shows. */
const WIDTH = 560;
/** How long "Sent to …" shows before the box goes. */
const SENT_MS = 900;

/** The browser preview can open the box with a message typed (`?ask=`), for screenshots. */
const previewAsk = import.meta.env.DEV ? new URLSearchParams(location.search).get("ask") ?? "" : "";

const hideBox = () => { if (inTauri) void getCurrentWindow().hide(); };

export function QuickAsk() {
  const team = useOrg().snap?.employees ?? [];
  const [text, setText] = useState(previewAsk);
  const [caret, setCaret] = useState(previewAsk.length);
  const [sel, setSel] = useState(0);
  const [state, setState] = useState<{ sent: string } | { error: string } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  /** Set while a send is under way, so a second Enter can't start a second conversation. */
  const sending = useRef(false);

  const pieces = namedPieces(text, team);
  const to = recipient(pieces);
  const mention = mentionAt(text, caret);
  const listed = mention ? mentionMatches(team, mention.query).slice(0, 6) : [];

  // The window hugs the box, so nothing shows around it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!inTauri || !el) return;
    const fit = new ResizeObserver(() => void getCurrentWindow().setSize(new LogicalSize(WIDTH, Math.ceil(el.offsetHeight))));
    fit.observe(el);
    return () => fit.disconnect();
  }, []);
  // Each time the shortcut brings the box back, the caret is in the field.
  useEffect(() => {
    const focus = () => field.current?.focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

  const edit = (value: string, at: number) => {
    setText(value);
    setCaret(at);
    setSel(0);
    if (state && "error" in state) setState(null);
  };
  const pick = (i: number) => {
    const who = listed[i];
    if (!mention || !who) return;
    const next = pickMention(text, mention.start, caret, who);
    edit(next.text, next.caret);
    requestAnimationFrame(() => field.current?.setSelectionRange(next.caret, next.caret));
  };
  const send = async () => {
    if (!to || !text.trim() || sending.current || (state && "sent" in state)) return;
    sending.current = true;
    try {
      await call("start_task", { employeeId: to.id, text: text.trim(), attachments: [] });
      setState({ sent: firstName(to.name) });
      window.setTimeout(() => { hideBox(); edit("", 0); setState(null); sending.current = false; }, SENT_MS);
    } catch (e) {
      sending.current = false;
      setState({ error: errorMessage(e) });
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (listed.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSel((s) => (s + (e.key === "ArrowDown" ? 1 : listed.length - 1)) % listed.length);
    } else if (listed.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
      e.preventDefault();
      pick(sel);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (mention) edit(text.slice(0, mention.start) + text.slice(caret), mention.start);
      else hideBox();
    }
  };

  let foot;
  if (state && "sent" in state) foot = <span className="qa-sent">Sent to {state.sent}</span>;
  else if (state) foot = <span className="qa-error" role="alert">{state.error}</span>;
  else if (to) foot = <span className="qa-to">To <Avatar name={to.name} hue={to.hue} image={to.image} size={18} /><b>{to.name}</b></span>;
  else foot = <span className="qa-hint">Type @ to pick who it's for</span>;

  return (
    <div ref={box} className="qa">
      <div className="qa-field">
        <div className="qa-mirror" aria-hidden>
          {pieces.map((p, i) => (p.who ? <mark key={i} className="qa-chip">{p.text}</mark> : <span key={i}>{p.text}</span>))}
          {"​"}
        </div>
        <textarea
          ref={field} autoFocus rows={1} value={text} spellCheck={false} aria-label="Quick ask"
          placeholder="Ask anyone on your team. Type @ to pick who."
          role="combobox" aria-expanded={listed.length > 0} aria-controls="qa-people"
          onChange={(e) => edit(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
        />
      </div>
      {listed.length ? (
        <div className="qa-people" id="qa-people" role="listbox">
          {listed.map((e, i) => (
            <button key={e.id} type="button" role="option" aria-selected={i === sel} className="qa-person" onMouseDown={(ev) => { ev.preventDefault(); pick(i); }}>
              <Avatar name={e.name} hue={e.hue} image={e.image} size={20} />
              <span className="qa-person-name">{e.name}</span>
              <span className="qa-person-title">{e.title}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="qa-foot">
        {foot}
        <span className="qa-keys"><span className="kbd">↵</span> Send <span className="kbd">esc</span> Close</span>
      </div>
    </div>
  );
}
