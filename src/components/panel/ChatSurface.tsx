import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../../api/client";
import type { EmployeeView, NewAttachment } from "../../api/types";
import { firstName } from "../../lib/format";
import { toast } from "../../lib/toasts";
import type { LiveRun } from "../../lib/runs";
import { getDraft, setDraft } from "../../lib/drafts";
import { useOrg } from "../../lib/hooks";
import { curve, ms, reducedMotion } from "../../lib/motion";
import { Icon } from "../Icon";
import { ConfirmButton, ErrorNote } from "../ui";
import { LiveStrip, LiveWork, WorkFocus, WorkSheet } from "../conversation/LiveWork";
import { workOf } from "../conversation/work";
import type { AimTarget } from "../conversation/CardView";
import "./ChatTab.css";

/** Narrower than this, the Live work column folds into a strip on the composer and opens as a sheet (the 980 window, a
 *  narrow panel). */
const COLUMN_MIN = 960;

const MAX_FILES = 10;
const MAX_FILE_MB = 20;

type Pending = { id: number; file: File; preview: string | null };
let pendingN = 0;

function toAttachment(file: File): Promise<NewAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(",", 2)[1] ?? "" });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export type ChatSurfaceHandle = {
  /** Puts text in the composer and moves the caret to its end. */
  prefill: (text: string) => void;
  focus: () => void;
  /** Aims the composer at a card, so what you write answers it (null: back to the conversation). */
  aim: (target: AimTarget | null) => void;
};

/**
 * The surface a conversation with an employee happens on: the scrolling transcript (`children`), a drop
 * zone for files, and the composer. Every conversation shares it; what differs is where a message goes
 * (`onSend`) and what sits in the composer's bar (`actions`). While a turn is in flight the
 * composer stays open: what you send reaches the employee as they work.
 */
export const ChatSurface = forwardRef<ChatSurfaceHandle, {
  e: EmployeeView;
  /** A turn is in flight. */
  busy: boolean;
  /** The turn in flight, for its sub-agents and the Stop button. */
  live?: LiveRun;
  placeholder: string;
  /** Said above the composer once you start typing: "This won't answer the card above." */
  cardNote?: string | null;
  /** The conversation's runs, for the Live work column beside the talk (or its strip, when narrow). "strip" never shows
   *  the column, as in the Inbox's one open item. */
  work?: { turns: LiveRun[]; mode?: "auto" | "strip" } | null;
  draftKey: string;
  /** Changes as content streams, so the view stays pinned to the bottom unless the reader scrolled up. */
  scrollKey: string;
  onSend: (text: string, attachments: NewAttachment[]) => Promise<void>;
  /** A second way to send, "Send & done" (also Ctrl or ⌘ + Enter): the message goes and the conversation is put away. */
  onSendDone?: (text: string, attachments: NewAttachment[]) => Promise<void>;
  onStop?: () => Promise<void>;
  /** Extra buttons in the bar, after the paperclip. */
  actions?: ReactNode;
  /** The composer takes focus when it appears. Off in an Inbox row, so its keys keep working until you click in. */
  autoFocus?: boolean;
  /** The card the composer is aimed at changed (its key, or null). */
  onAim?: (key: string | null) => void;
  /** Open at the end of the conversation and keep to it (a thread); off for a page read from the top (a new one). */
  pin?: boolean;
  children: ReactNode;
}>(function ChatSurface({ e, busy, live, placeholder, cardNote, work, draftKey, scrollKey, onSend, onSendDone, onStop, actions, autoFocus = true, onAim, pin = true, children }, ref) {
  const [text, setText] = useState(() => getDraft(draftKey));
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(pin);
  // Until you scroll, the opening view lands on whole lines: a spacer at the end takes up the part of a line the top
  // edge would cut, so the top line is either whole or gone.
  const touched = useRef(false);
  const spacer = useRef<HTMLDivElement>(null);
  const landWhole = useCallback(() => {
    const el = scroller.current, sp = spacer.current;
    if (!el || !sp || touched.current) return;
    sp.style.height = "0px";
    el.scrollTop = el.scrollHeight;
    const top = el.getBoundingClientRect().top;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent?.trim()) continue;
      range.selectNodeContents(n);
      const box = range.getBoundingClientRect();
      if (box.bottom <= top || box.top >= top + 2) { if (box.top >= top + 2) break; continue; }
      for (const line of range.getClientRects()) {
        if (line.top < top - 0.5 && line.bottom > top + 0.5) {
          const cut = Math.ceil(line.bottom - top);
          if (cut > 0 && cut <= 48) { sp.style.height = `${cut}px`; el.scrollTop = el.scrollHeight; }
          return;
        }
      }
    }
  }, []);
  const name = firstName(e.name);
  const hasContent = !!text.trim() || files.length > 0;
  const { snap } = useOrg();
  const employees = snap?.employees;
  const model = useMemo(() => (work ? workOf(work.turns, employees ?? []) : null), [work, employees]);
  const hasWork = !!model && (model.cards.length > 0 || model.turn.length > 0 || model.earlier.length > 0);
  const liveWork = !!model && model.cards.length > 0;

  // Column or strip, from the surface's own width: the same in the full window and in a person's panel.
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // One rule for the column: where it fits, it docks beside the talk while anything is live, or when you open it from
  // a chip, and stays until you close it or leave; with nothing live it is not there, so a finished conversation always
  // opens with the talk in one place. Where it does not fit, it is the strip on the composer and opens as a sheet.
  const wide = work?.mode !== "strip" && width >= COLUMN_MIN;
  const [docked, setDocked] = useState(liveWork);
  const [closedByYou, setClosedByYou] = useState(false);
  useEffect(() => { if (liveWork && !closedByYou) setDocked(true); }, [liveWork, closedByYou]);
  const column = wide && docked && hasWork;
  const [sheet, setSheet] = useState(false);
  useEffect(() => { if (wide) setSheet(false); }, [wide]);
  const [reveal, setReveal] = useState<{ key: string; n: number } | null>(null);
  const openWork = useCallback(() => {
    if (wide) { setDocked(true); setClosedByYou(false); } else setSheet(true);
  }, [wide]);
  const focusWork = useCallback((key: string) => {
    setReveal((r) => ({ key, n: (r?.n ?? 0) + 1 }));
    openWork();
  }, [openWork]);
  const closeSheet = useCallback(() => setSheet(false), []);
  const closeColumn = useCallback(() => {
    // Hide's tooltip leaves with the column.
    (document.activeElement as HTMLElement | null)?.blur();
    setDocked(false);
    setClosedByYou(true);
  }, []);

  // The composer aimed at a card: what you write answers that card.
  const [aim, setAimState] = useState<AimTarget | null>(null);
  const onAimRef = useRef(onAim);
  onAimRef.current = onAim;
  const setAim = useCallback((t: AimTarget | null) => {
    setAimState(t);
    onAimRef.current?.(t?.key ?? null);
    if (t) requestAnimationFrame(() => input.current?.focus());
  }, []);

  // The column opening or closing is one resizing layout: it slides in from (or out to) the right edge by its own width
  // while the talk moves over to make room on the same clock, never jumping. On opening a conversation it is simply
  // there. A closing column stays mounted, laid over the edge, until it has slid out.
  const columnEl = useRef<HTMLDivElement>(null);
  const talkEl = useRef<HTMLDivElement>(null);
  const hadColumn = useRef<boolean | null>(null);
  const [leaving, setLeaving] = useState(false);
  // Known in the same render the column closes, so it stays mounted to slide out.
  const [prevColumn, setPrevColumn] = useState(column);
  if (prevColumn !== column) {
    setPrevColumn(column);
    setLeaving(!column && hadColumn.current === true);
  }
  const talkLeft = useRef<number | null>(null);
  // Where the talk is laid out, ignoring any move in flight (offsetLeft does not include transforms).
  const readLeft = () => talkEl.current?.querySelector<HTMLElement>(".chat-inner")?.offsetLeft ?? null;
  useLayoutEffect(() => {
    const was = hadColumn.current;
    if (width) hadColumn.current = column;
    if (was === null || was === column || !width) return;
    const reduced = reducedMotion();
    const dur = reduced ? ms("--d-fade") : ms("--d-panel");
    const ease = reduced ? "linear" : curve("--ease-move");
    // The talk: from where it was to where it now sits, as a transform on one clock with the column.
    const before = talkLeft.current, after = readLeft();
    if (!reduced && before !== null && after !== null && Math.abs(before - after) > 0.5) {
      const dx = before - after;
      for (const el of talkEl.current?.querySelectorAll<HTMLElement>(".chat-inner, .composer-wrap") ?? []) {
        el.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: dur, easing: ease });
      }
    }
    const col = columnEl.current;
    if (column) {
      col?.animate(reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: "translateX(100%)" }, { transform: "none" }], { duration: dur, easing: ease, fill: "backwards" });
    } else if (col) {
      const a = col.animate(reduced ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: "none" }, { transform: "translateX(100%)" }], { duration: dur, easing: ease, fill: "forwards" });
      void a.finished.then(() => setLeaving(false), () => setLeaving(false));
    } else setLeaving(false);
  }, [column, width]);
  // Where the talk sits, read after every layout, so the next column change knows where it moves from.
  useLayoutEffect(() => { talkLeft.current = readLeft(); });
  // A turn takes messages until its result; after that a message waits to be its next turn. A turn the
  // usage limit sent back to the queue starts again at a new init, so only a result after it counts.
  const attempt = live ? live.events.slice(live.events.map((ev) => ev.type).lastIndexOf("init") + 1) : [];
  const steerable = live?.run.state === "running" && !attempt.some((ev) => ev.type === "result");

  useImperativeHandle(ref, () => ({
    prefill: (t) => {
      setText(t);
      requestAnimationFrame(() => {
        const el = input.current;
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      });
    },
    focus: () => input.current?.focus(),
    aim: setAim,
  }), [setAim]);

  useEffect(() => { setDraft(draftKey, text); }, [draftKey, text]);

  // Previews are object URLs: release them when they leave the composer.
  const previews = useRef(new Set<string>());
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);
  const clearFiles = (keep: Pending[] = []) => {
    for (const f of files) if (f.preview && !keep.includes(f)) { URL.revokeObjectURL(f.preview); previews.current.delete(f.preview); }
    setFiles(keep);
  };

  const addFiles = (list: File[]) => {
    if (sending || list.length === 0) return;
    const tooBig = list.filter((f) => f.size > MAX_FILE_MB * 1024 * 1024);
    if (tooBig.length) toast(`${tooBig.map((f) => f.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} over ${MAX_FILE_MB} MB.`, "err");
    const room = MAX_FILES - files.length;
    const ok = list.filter((f) => !tooBig.includes(f));
    if (ok.length > room) toast(`Attach up to ${MAX_FILES} files at a time.`, "err");
    const added = ok.slice(0, Math.max(0, room)).map((file) => {
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      if (preview) previews.current.add(preview);
      return { id: ++pendingN, file, preview };
    });
    if (added.length) setFiles((cur) => [...cur, ...added]);
    input.current?.focus();
  };

  // Keep pinned to the bottom while content streams, unless the reader scrolled up. A new line eases into view rather
  // than jumping the thread; opening a conversation, or a big change, is simply there.
  const settled = useRef(false);
  const easing = useRef<{ frame: number; from: number; at: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current || !pin) return;
    const delta = el.scrollHeight - el.clientHeight - el.scrollTop;
    if (delta <= 0) { settled.current = true; return; }
    if (!settled.current || delta >= 160 || reducedMotion()) {
      el.scrollTop = el.scrollHeight;
      if (!settled.current) landWhole();
      settled.current = true;
      return;
    }
    // Ease toward the bottom over --d-arrive; a line that arrives mid-ease retargets from where it is.
    if (easing.current) cancelAnimationFrame(easing.current.frame);
    const from = el.scrollTop;
    const at = performance.now();
    const dur = ms("--d-arrive") || 320;
    const step = (now: number) => {
      const t = Math.min(1, (now - at) / dur);
      const k = 1 - Math.pow(1 - t, 3);
      const target = el.scrollHeight - el.clientHeight;
      el.scrollTop = from + (target - from) * k;
      if (t < 1) easing.current = { frame: requestAnimationFrame(step), from, at };
      else { easing.current = null; landWhole(); }
    };
    easing.current = { frame: requestAnimationFrame(step), from, at };
  }, [scrollKey, landWhole, pin]);
  useEffect(() => () => { if (easing.current) cancelAnimationFrame(easing.current.frame); }, []);
  // What loads after the conversation opens (a draft, pictures, a page's height) keeps the end in view, so the last
  // question never opens cut off under the composer.
  useLayoutEffect(() => {
    const el = scroller.current, inner = el?.firstElementChild;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (!stick.current || easing.current) return;
      if (touched.current) { el.scrollTop = el.scrollHeight; return; }
      landWhole();
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [landWhole]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(200, Math.max(44, el.scrollHeight))}px`;
  }, [text]);

  const wasSending = useRef(false);
  useEffect(() => {
    if (!sending && (autoFocus || wasSending.current)) input.current?.focus({ preventScroll: true });
    wasSending.current = sending;
  }, [sending, autoFocus]);

  const send = async (to = onSend) => {
    const body = text.trim();
    if (aim) {
      if (!body || sending) return;
      // The words go to the card at once: the composer clears and the card shows them on their way, with Undo. If they
      // do not go (Undo, or a failure), they come back here, aimed at the same card.
      const target = aim;
      setSendError(null);
      setDraft(draftKey, "");
      setText("");
      setAim(null);
      try {
        if (!(await target.send(body))) {
          setText((cur) => (cur.trim() ? cur : body));
          setAim(target);
        }
      } catch (err) {
        setSendError(errorMessage(err));
        setText((cur) => (cur.trim() ? cur : body));
        setAim(target);
      }
      return;
    }
    if ((!body && !files.length) || sending) return;
    setSending(true);
    setSendError(null);
    stick.current = true;
    try {
      const attachments = await Promise.all(files.map((f) => toAttachment(f.file)));
      await to(body, attachments);
      // Cleared in the store too: sending may have moved you to another conversation already.
      setDraft(draftKey, "");
      setText("");
      clearFiles();
    } catch (err) {
      setSendError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div ref={root} className={`chat ${column ? "chat-with-work" : ""}`}>
    <div
      ref={talkEl}
      className={`chat-talk ${dragging ? "chat-dragging" : ""}`}
      onDragOver={(ev) => {
        if (!ev.dataTransfer.types.includes("Files") || sending) return;
        ev.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(ev) => {
        ev.preventDefault();
        setDragging(false);
        addFiles([...ev.dataTransfer.files]);
      }}
    >
      {dragging ? <div className="chat-drop"><Icon name="paperclip" size={18} /> Drop to attach for {name}</div> : null}
      <div className="chat-scroll" ref={scroller}
        onWheel={() => { touched.current = true; }} onTouchMove={() => { touched.current = true; }} onKeyDown={() => { touched.current = true; }}
        onScroll={(ev) => {
          const el = ev.currentTarget;
          if (!pin) return;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
        }}>
        <div className="chat-scroll-inner">
          <WorkFocus.Provider value={hasWork ? focusWork : null}>{children}</WorkFocus.Provider>
          <div ref={spacer} className="chat-land" aria-hidden />
        </div>
      </div>
      <div className="composer-wrap">
        {sendError ? <ErrorNote text={sendError} /> : null}
        {cardNote && text.trim() && !aim ? <p className="composer-note enter-fade" role="status"><Icon name="alert" size={13} /> {cardNote}</p> : null}
        <div className="composer-stack">
        {!column && model && liveWork ? <LiveStrip cards={model.cards} open={sheet} onShow={openWork} max={width < 420 ? 1 : width >= 640 ? 3 : 2} /> : null}
        {aim ? (
          <div className="composer-aim enter-fade">
            <Icon name="reply" size={14} />
            <span className="composer-aim-what"><span className="muted">Answering</span> <b>{aim.label}</b></span>
            <button type="button" className="btn btn-ghost btn-sm" disabled={sending || !text.trim()} data-tip="Sends it as a question. The card stays open."
              onClick={async () => { const t = text.trim(); if (t && await aim.ask(t)) { setText(""); setDraft(draftKey, ""); } }}>Ask instead</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={sending} data-tip={`${aim.name} sums it up in three short lines. The card stays open.`} onClick={aim.summarise}>Summarise</button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Back to the conversation" data-tip="Back to the conversation (Esc)" onClick={() => setAim(null)}><Icon name="close" size={14} /></button>
          </div>
        ) : null}
        <div className={`composer ${sending ? "composer-busy" : ""}`}>
          {files.length ? (
            <div className="composer-files">
              {files.map((f) => (
                <div key={f.id} className={`attach ${f.preview ? "attach-image" : ""}`} title={f.file.name}>
                  {f.preview ? <img src={f.preview} alt={f.file.name} /> : <><Icon name="file" size={13} /><span className="attach-name">{f.file.name}</span></>}
                  <button className="attach-remove" aria-label={`Remove ${f.file.name}`} disabled={sending} onClick={() => clearFiles(files.filter((x) => x !== f))}>
                    <Icon name="close" size={10} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            ref={input} className="composer-input" value={text} disabled={sending} rows={1}
            placeholder={aim ? `Your answer for ${aim.name}` : !busy ? placeholder : steerable ? `Message ${name}. They'll see it as they work.` : `Message ${name}. It goes to them as their next turn.`}
            onChange={(ev) => setText(ev.target.value)}
            onPaste={(ev) => {
              const pasted = [...ev.clipboardData.files];
              if (pasted.length) { ev.preventDefault(); addFiles(pasted); }
            }}
            onKeyDown={(ev) => {
              if (ev.key === "Escape" && aim) { ev.preventDefault(); ev.stopPropagation(); setAim(null); return; }
              if (ev.key === "Enter" && !ev.shiftKey && !ev.nativeEvent.isComposing) { ev.preventDefault(); void send(onSendDone && !aim && (ev.metaKey || ev.ctrlKey) ? onSendDone : onSend); }
            }}
            aria-label={placeholder}
          />
          <div className="composer-bar">
            <input ref={picker} type="file" multiple hidden onChange={(ev) => { addFiles([...(ev.target.files ?? [])]); ev.target.value = ""; }} />
            <button className="btn btn-ghost btn-icon btn-sm" aria-label="Attach files" data-tip="Attach files, or paste a screenshot" onClick={() => picker.current?.click()} disabled={sending || !!aim}><Icon name="paperclip" size={14} /></button>
            {actions}
            <span className="grow" />
            {live && onStop ? (
              <ConfirmButton label="Stop" icon="stop" className="btn btn-ghost" size="btn-sm" question={`Stop ${name}?`} confirmLabel="Stop it" onConfirm={onStop} />
            ) : null}
            {onSendDone && hasContent && !aim ? (
              <button className="btn btn-sm" data-tip="Send, and bring it back only if the answer needs you (Ctrl+Enter)" disabled={sending} onClick={() => void send(onSendDone)}>
                Send &amp; done
              </button>
            ) : null}
            <button className={`btn btn-icon btn-sm composer-send ${hasContent ? "composer-send-ready" : ""}`} aria-label={aim ? "Send your answer" : "Send"} data-tip={aim ? "Answers the card (Enter)" : "Send (Enter). Shift+Enter adds a new line."} disabled={sending || !hasContent} onClick={() => void send()}>
              <Icon name="send" size={15} strokeWidth={1.75} />
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
      {(column || leaving) && model ? <div ref={columnEl} className={`chat-work ${column ? "" : "chat-work-leaving"}`}><LiveWork model={model} reveal={reveal} onHide={closeColumn} /></div> : null}
      {!wide && model && hasWork ? (
        <WorkSheet open={sheet} onClose={closeSheet}><LiveWork model={model} reveal={reveal} onClose={closeSheet} /></WorkSheet>
      ) : null}
    </div>
  );
});
