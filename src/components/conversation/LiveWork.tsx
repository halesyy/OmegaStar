import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { firstName } from "../../lib/format";
import { useRunDetail } from "../../lib/hooks";
import { curve, ms, reducedMotion, rollAnimations } from "../../lib/motion";
import { openRun } from "../../lib/router";
import { useScrollFade } from "../../lib/scrollFade";
import { Icon } from "../Icon";
import { StepMark, stepWords } from "../Transcript";
import { Avatar, Roll, StatePill } from "../ui";
import { compactNumber, minutes, type WorkCard, type WorkModel, type WorkRow } from "./work";
import "./LiveWork.css";

/** Points the column at a card or row: opens the column (or, where it does not fit, the sheet), scrolls to it and marks
 *  it once. Null outside a surface with work to show (an empty conversation). */
export const WorkFocus = createContext<((key: string) => void) | null>(null);
export const useWorkFocus = () => useContext(WorkFocus);

/** How long a finished card holds its Done before it becomes its row. */
const HOLD_MS = 520;
/** Earlier rows shown before Show all. */
const EARLIER = 5;

/** A line that rolls to its new words when `k` changes: the old one leaves as the new one arrives, in one slot. */
function RollLine({ k, children }: { k: string; children: ReactNode }) {
  const [roll, setRoll] = useState<{ k: string; from: ReactNode; on: boolean }>({ k, from: null, on: false });
  const last = useRef<ReactNode>(children);
  if (roll.k !== k) setRoll({ k, from: last.current, on: true });
  useLayoutEffect(() => { last.current = children; });
  const slot = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = slot.current;
    if (!roll.on || !el || el.children.length < 2) return;
    const anims = rollAnimations(el.children[0] as HTMLElement, el.children[1] as HTMLElement, true);
    let live = true;
    void Promise.all(anims.map((a) => a.finished)).then(() => { if (live) setRoll((r) => ({ ...r, from: null, on: false })); }, () => {});
    return () => { live = false; anims.forEach((a) => a.cancel()); };
  }, [roll.on, roll.k]);
  return (
    <span ref={slot} className="roll roll-line">
      {roll.on ? <><span aria-hidden>{roll.from}</span><span>{children}</span></> : <span>{children}</span>}
    </span>
  );
}

/** What a delegate is doing now: its latest step, read from its own run. `short`: for the strip. */
function useChildNow(runId: string) {
  const { detail } = useRunDetail(runId);
  const calls = detail?.events.filter((ev) => ev.type === "toolCall") ?? [];
  const last = calls[calls.length - 1];
  if (!last || last.type !== "toolCall") return { key: detail ? "start" : "", label: detail ? "Starting" : "", what: "", code: false, short: "" };
  const w = stepWords(last.tool, last.brief, true);
  const bash = last.tool === "Bash";
  return { key: last.id, label: bash ? "Now" : w.verb, what: w.object, code: w.code, short: bash ? last.brief.trim().split(/\s+/).slice(0, 2).join(" ") : w.code ? w.object : w.verb };
}
/** The delegate's line: what they are doing now, rolling in its slot as each step comes, and to "Reported back" (or
 *  "Didn't finish") when they finish. One slot throughout, so that last change rolls too. */
function ChildNow({ runId, finished }: { runId: string; finished: "ok" | "err" | null }) {
  const n = useChildNow(runId);
  if (finished) return <RollLine k={`done:${finished}`}><span className="run-now-label">{finished === "err" ? "Didn't finish" : "Reported back"}</span></RollLine>;
  return <RollLine k={n.key}><span className="run-now-label">{n.label}</span>{n.what ? <span className={`run-now-what ${n.code ? "mono" : ""}`}>{n.what}</span> : null}</RollLine>;
}
function ChildNowShort({ runId }: { runId: string }) {
  const n = useChildNow(runId);
  return <span className={n.code ? "mono" : ""}>{n.short}</span>;
}

/** A sub-agent's "Reading billing/annual-plans.md": the verb, then a single path or command in mono. */
function AgentNow({ activity, finished }: { activity: string | null; finished: "ok" | "err" | null }) {
  const m = activity ? /^(\S+)\s+(.+)$/.exec(activity) : null;
  const code = !!m && /^\S+$/.test(m[2]) && /[/.]/.test(m[2]);
  return (
    <RollLine k={finished ? `done:${finished}` : activity ?? ""}>
      {finished ? <span className="run-now-label">{finished === "err" ? "Didn't finish" : "Finished"}</span>
        : !activity ? <span className="run-now-label">Starting</span>
        : m ? <><span className="run-now-label">{m[1]}</span><span className={`run-now-what ${code ? "mono" : ""}`}>{m[2]}</span></>
        : <span className="run-now-what">{activity}</span>}
    </RollLine>
  );
}

/** A live card: who, their word in the one status form (a pill), the task, what they are doing now. */
function CardView({ card, finished }: { card: WorkCard; finished: "ok" | "err" | null }) {
  const word = finished === "err" ? "Failed" : finished === "ok" ? "Done" : card.kind === "delegate" && card.child?.state === "queued" ? "Up next" : "Working";
  const tone = finished === "err" ? "err" : finished === "ok" ? "ok" : word === "Up next" ? "wait" : "accent";
  const pill = <StatePill tone={tone}><Roll value={word} /></StatePill>;
  if (card.kind === "delegate") {
    const e = card.employee;
    return (
      <button type="button" className="run-card" data-work={card.key} onClick={() => openRun(card.childRunId)} data-tip="Open their run">
        <span className="run-top">
          {e ? <Avatar name={e.name} hue={e.hue} size={24} /> : <Icon name="branch" size={16} className="muted" />}
          <span className="run-who trunc">{e ? e.name : card.asked ? "A colleague" : "A report"}</span>
          {pill}
        </span>
        <span className="run-what">{card.task}</span>
        <span className="run-now"><ChildNow runId={card.childRunId} finished={finished} /></span>
      </button>
    );
  }
  const t = card.task;
  return (
    <div className="run-card" data-work={card.key} tabIndex={-1}>
      <span className="run-top">
        <Icon name="layers" size={16} className="muted" />
        <span className="run-who trunc">Sub-agent</span>
        {pill}
      </span>
      <span className="run-what">{t.name}</span>
      <span className="run-now"><AgentNow activity={t.activity} finished={finished} /></span>
      <span className="run-stats">
        <span><b className="num"><Roll value={t.toolUses} /></b> {t.toolUses === 1 ? "call" : "calls"}</span>
        <span><b className="num"><Roll value={compactNumber(t.tokens)} /></b> tokens</span>
        <span className="num"><Roll value={minutes(t.durationMs)} /></span>
      </span>
    </div>
  );
}

/** A row's face: icon, verb, what it acted on, its meta and its mark. */
function RowBody({ row }: { row: WorkRow }) {
  return (
    <>
      {row.avatar ? <Avatar name={row.avatar.name} hue={row.avatar.hue} size={16} /> : <Icon name={row.icon} size={14} className="done-icon" />}
      <span className="done-text">
        <span className="done-verb">{row.verb}</span>
        <span className={`done-what ${row.code ? "mono" : ""}`}>{row.object}</span>
      </span>
      {row.meta ? <span className="done-meta num">{row.meta}</span> : null}
      {row.tag ? <span className="tag">{row.tag}</span> : <StepMark status={row.state} />}
    </>
  );
}

/** A row of the column; it opens to show what came back, or opens its run. */
function Row({ row, open, onToggle }: { row: WorkRow; open: boolean; onToggle: () => void }) {
  const canOpen = !!row.detail || row.key.startsWith("d:");
  return (
    <div className={`done-item ${open ? "done-open" : ""}`}>
      {canOpen ? (
        <button type="button" className="done-row" data-work={row.key} aria-expanded={row.detail ? open : undefined}
          onClick={() => (row.detail ? onToggle() : row.runId ? openRun(row.runId) : undefined)}>
          <RowBody row={row} />
        </button>
      ) : <div className="done-row" data-work={row.key} tabIndex={-1}><RowBody row={row} /></div>}
      {row.detail ? (
        <div className="collapse" data-open={open}>
          <div><p className="done-detail">{row.detail}</p></div>
        </div>
      ) : null}
    </div>
  );
}

/** Rows and cards that arrive while you watch open their own room (`.collapse`), so what is below moves with them; those
 *  there when the column opened are simply there. Returns the keys still closed this frame. */
function useOpening(keys: string[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [closed, setClosed] = useState<string[]>([]);
  const first = seen.current === null;
  if (first) seen.current = new Set(keys);
  const fresh = first ? [] : keys.filter((k) => !seen.current!.has(k));
  if (fresh.length) {
    fresh.forEach((k) => seen.current!.add(k));
    setClosed((c) => [...c, ...fresh]);
  }
  useEffect(() => {
    if (!closed.length) return;
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setClosed([])); });
    return () => cancelAnimationFrame(frame);
  }, [closed]);
  return new Set([...closed, ...fresh]);
}

type Phase = "hold" | "morph" | "fly" | "fade";
type Held = { card: WorkCard; at: number; phase: Phase; index: number; from: number };

/**
 * Finished work goes to This turn as one object. The card holds its Done for a beat, shrinks into its row where it
 * stands, then that row travels, lifted, to the top of This turn while the cards close the gap and This turn opens for
 * it on the same clock; it lands flat and the real row takes over. While it shrinks, the card's words go first, then
 * the surface shrinks with nothing on it, then the row's words come in: never two sets of words at once, and no edge
 * crosses text. Under reduced motion nothing travels: the card's words fade out as the row fades in, on one clock, then
 * the card's space closes. A card that just finished joins `held` in the same render it leaves the live list, so it
 * never blinks out.
 */
function useFinishing(cards: WorkCard[], rows: WorkRow[], els: Map<string, HTMLElement>, body: () => HTMLElement | null) {
  const [held, setHeld] = useState<Held[]>([]);
  const [landing, setLanding] = useState<string[]>([]);
  const [prev, setPrev] = useState(cards);
  if (prev !== cards) {
    const now = new Set(cards.map((c) => c.key));
    const gone = prev.filter((c) => !now.has(c.key));
    setPrev(cards);
    if (gone.length) setHeld((h) => [...h.filter((x) => !gone.some((g) => g.key === x.card.key)), ...gone.map((card) => ({ card, at: Date.now(), phase: "hold" as Phase, index: prev.indexOf(card), from: 0 }))]);
  }
  const advance = useCallback((key: string, phase: Phase | null) => {
    if (phase === "morph") {
      // Measured now, while the card is still whole, so the shrink starts from its real height.
      const from = els.get(key)?.offsetHeight ?? 0;
      setHeld((x) => x.map((y) => (y.card.key === key ? { ...y, phase, from } : y)));
    } else if (phase) setHeld((x) => x.map((y) => (y.card.key === key ? { ...y, phase } : y)));
    else { setHeld((x) => x.filter((y) => y.card.key !== key)); setLanding((l) => l.filter((k) => k !== key)); }
  }, [els]);
  useEffect(() => {
    if (!held.length) return;
    const reduced = reducedMotion();
    const timers = held.map((h) => {
      if (h.phase === "hold") return window.setTimeout(() => advance(h.card.key, reduced ? "fade" : "morph"), Math.max(0, HOLD_MS - (Date.now() - h.at)));
      if (h.phase === "morph") return window.setTimeout(() => advance(h.card.key, "fly"), ms("--d-ui") + ms("--d-arrive"));
      if (h.phase === "fade") return window.setTimeout(() => advance(h.card.key, null), ms("--d-fade") + 40);
      return window.setTimeout(() => advance(h.card.key, null), ms("--d-settle") + 120);
    });
    return () => timers.forEach(window.clearTimeout);
  }, [held, advance]);
  // The moves that need measuring: the shrink, then the flight.
  const done = useRef(new Set<string>());
  useLayoutEffect(() => {
    for (const h of held) {
      const tag = `${h.card.key}:${h.phase}`;
      if (done.current.has(tag)) continue;
      done.current.add(tag);
      const el = els.get(h.card.key);
      if (!el || reducedMotion()) continue;
      if (h.phase === "morph") {
        // First the card's words fade (its surface holds its height), then the empty surface shrinks to the row's size,
        // then the row's words come in on it.
        const up = ms("--d-ui"), arr = ms("--d-arrive");
        el.animate([{ height: `${h.from}px` }, { height: `${el.offsetHeight}px` }], { duration: arr, delay: up, easing: curve("--ease"), fill: "backwards" });
        const morph = el.querySelector<HTMLElement>(".run-morph");
        morph?.animate([{ height: `${h.from - 10}px` }, { height: `${morph.offsetHeight}px` }], { duration: arr, delay: up, easing: curve("--ease"), fill: "backwards" });
        for (const part of morph ? [...morph.children] : []) {
          const ghost = (part as HTMLElement).classList.contains("run-ghost");
          (part as HTMLElement).animate(ghost ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }],
            ghost ? { duration: up, easing: "linear", fill: "forwards" } : { duration: arr * 0.4, delay: up + arr * 0.6, easing: "linear", fill: "backwards" });
        }
      } else if (h.phase === "fly") {
        const slot = body()?.querySelector<HTMLElement>(`.work-rows [data-key="${CSS.escape(h.card.key)}"]`);
        if (!slot) continue;
        const src = el.getBoundingClientRect();
        const dst = slot.getBoundingClientRect();
        // Where the row will rest once the cards above have closed the gap this card leaves.
        const gap = el.offsetHeight + parseFloat(getComputedStyle(el).marginBottom || "0");
        const flyer = el.cloneNode(true) as HTMLElement;
        // The flight carries the row alone: the card's faded words stay behind.
        flyer.querySelectorAll(".run-ghost").forEach((g) => g.remove());
        Object.assign(flyer.style, { position: "fixed", left: `${src.left}px`, top: `${src.top}px`, width: `${src.width}px`, height: `${src.height}px`, margin: "0", zIndex: "40", pointerEvents: "none", visibility: "visible" });
        flyer.classList.add("run-flyer");
        document.body.append(flyer);
        el.style.visibility = "hidden";
        const dx = dst.left - src.left, dy = dst.top - gap - src.top;
        const shadow = getComputedStyle(document.documentElement).getPropertyValue("--shadow-float").trim() || "none";
        const a = flyer.animate([
          { transform: "none", boxShadow: "none", width: `${src.width}px` },
          { transform: `translate(${dx * 0.5}px, ${dy * 0.5}px)`, boxShadow: shadow, offset: 0.5 },
          { transform: `translate(${dx}px, ${dy}px)`, boxShadow: "none", width: `${dst.width}px` },
        ], { duration: ms("--d-settle"), easing: curve("--ease-move"), fill: "forwards" });
        // The real row shows at the same place first, then the flyer goes on the next frame: no frame without the row.
        void a.finished.then(() => {
          slot.classList.remove("done-landing");
          setLanding((l) => l.filter((k) => k !== h.card.key));
          requestAnimationFrame(() => requestAnimationFrame(() => flyer.remove()));
        }, () => flyer.remove());
        setLanding((l) => [...l, h.card.key]);
      }
    }
  }, [held, els, body]);
  const stateOf = (key: string): "ok" | "err" => (rows.find((r) => r.key === key)?.state === "err" ? "err" : "ok");
  return {
    held: held.map((h) => ({ ...h, finished: stateOf(h.card.key), row: rows.find((r) => r.key === h.card.key) })),
    /** Rows still closed: their card is holding or shrinking. */
    holding: new Set(held.filter((h) => h.phase === "hold" || h.phase === "morph").map((h) => h.card.key)),
    /** Rows open but empty: the flying row is about to land in them. */
    landing: new Set(landing),
  };
}

/**
 * The Live work column: who else is working on this and what each is doing now, then This turn's steps and the steps
 * of Earlier replies. Docked beside the talk it has Hide (`onHide`); as a sheet over the talk, Close (`onClose`).
 * `reveal` asks it to show one card or row: it opens Earlier if it must, scrolls there and marks it once.
 */
export function LiveWork({ model, onClose, onHide, reveal }: { model: WorkModel; onClose?: () => void; onHide?: () => void; reveal: { key: string; n: number } | null }) {
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [allEarlier, setAllEarlier] = useState(false);
  const els = useRef(new Map<string, HTMLElement>()).current;
  const body = useRef<HTMLDivElement | null>(null);
  const getBody = useCallback(() => body.current, []);
  const { held, holding, landing } = useFinishing(model.cards, [...model.turn, ...model.earlier], els, getBody);
  // A finished card stays where it stood while it holds, shrinks and leaves.
  const cards: { card: WorkCard; held?: (typeof held)[number] }[] = model.cards.map((card) => ({ card }));
  for (const h of [...held].sort((a, b) => a.index - b.index)) cards.splice(Math.min(Math.max(h.index, 0), cards.length), 0, { card: h.card, held: h });
  const liveCount = model.cards.length;
  const opening = useOpening([...cards.map((c) => c.card.key), ...model.turn.map((r) => r.key), ...model.earlier.map((r) => r.key)]);
  const fade = useScrollFade<HTMLDivElement>();
  const earlier = allEarlier || model.earlier.length <= EARLIER + 1 ? model.earlier : model.earlier.slice(0, EARLIER);

  // A chip pressed in the talk: open Earlier when its row is folded there, then scroll to it and mark it once.
  const [pending, setPending] = useState<{ key: string; n: number } | null>(null);
  useEffect(() => {
    if (!reveal) return;
    if (!allEarlier && model.earlier.slice(EARLIER).some((r) => r.key === reveal.key) && model.earlier.length > EARLIER + 1) setAllEarlier(true);
    setPending(reveal);
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!pending || !body.current) return;
    const el = body.current.querySelector<HTMLElement>(`[data-work="${CSS.escape(pending.key)}"]`);
    setPending(null);
    if (!el) return;
    // Only the column's own list scrolls: nothing outside it (the page, the panel) is moved to bring the row into view.
    const b = body.current, br = b.getBoundingClientRect(), er = el.getBoundingClientRect();
    const by = er.top < br.top ? er.top - br.top - 8 : er.bottom > br.bottom ? er.bottom - br.bottom + 8 : 0;
    if (by) b.scrollTo({ top: b.scrollTop + by, behavior: reducedMotion() ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
    const fill = `color-mix(in oklab, ${getComputedStyle(document.documentElement).getPropertyValue("--ink").trim()} 9%, transparent)`;
    el.animate([{ backgroundColor: fill }, { backgroundColor: fill, offset: 0.4 }, { backgroundColor: "transparent" }], { duration: ms("--d-panel") * 5, easing: curve("--ease") });
  }, [pending]);

  const setBody = (el: HTMLDivElement | null) => { body.current = el; fade.current = el; };
  const rows = (list: WorkRow[]) => list.map((r) => (
    <div key={r.key} data-key={r.key} className={`collapse ${landing.has(r.key) ? "done-landing" : ""}`} data-open={!holding.has(r.key) && !opening.has(r.key)}>
      <div><Row row={r} open={openRow === r.key} onToggle={() => setOpenRow(openRow === r.key ? null : r.key)} /></div>
    </div>
  ));
  return (
    <aside className={`work ${onClose ? "work-sheet" : ""}`} aria-label="Live work">
      <div className="work-head">
        <span className="work-title">{liveCount ? "Live work" : "Work"}</span>
        {liveCount ? <span className="work-n num" aria-live="polite"><Roll value={liveCount} /></span> : null}
        <span className="grow" />
        {onClose ? <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Close live work" data-tip="Close (Esc)" onClick={onClose}><Icon name="close" size={15} /></button> : null}
        {onHide ? <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Hide live work" data-tip="Hide" onClick={onHide}><Icon name="close" size={15} /></button> : null}
      </div>
      <div className="work-body scroll-fade" ref={setBody}>
        {cards.length ? (
          <div className="work-cards">
            {cards.map(({ card, held: h }) => (
              <div key={card.key} data-key={card.key} className="collapse" data-open={h?.phase !== "fly" && !opening.has(card.key)}>
                <div>
                  <div className={`run-slot ${h?.phase === "fade" ? "run-fading" : ""}`} ref={(el) => { if (el) els.set(card.key, el); else els.delete(card.key); }}>
                    {h && h.phase !== "hold" && h.row && !reducedMotion() ? (
                      <div className="run-morph">
                        <div className="run-ghost" aria-hidden><CardView card={card} finished={h.finished} /></div>
                        <RowBody row={h.row} />
                      </div>
                    ) : <CardView card={card} finished={h ? h.finished : null} />}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {model.turn.length ? (
          <section className="work-sec">
            <h3 className="work-sec-title">This turn</h3>
            <div className="work-rows">{rows(model.turn)}</div>
          </section>
        ) : null}
        {model.earlier.length ? (
          <section className="work-sec">
            <h3 className="work-sec-title">Earlier in this conversation</h3>
            <div className="work-rows">{rows(earlier)}</div>
            {earlier.length < model.earlier.length ? (
              <button type="button" className="btn btn-ghost btn-sm work-more" onClick={() => setAllEarlier(true)}>Show all {model.earlier.length}</button>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

/** The column folded into a strip on the composer: the live count, the runs that fit and what each is doing, and Show.
 *  A run that finishes fades and closes its own space where it stood, so the others slide over on the same clock. */
export function LiveStrip({ cards, open, onShow, max = 2 }: { cards: WorkCard[]; open: boolean; onShow: () => void; max?: number }) {
  const [leaving, setLeaving] = useState<{ card: WorkCard; index: number }[]>([]);
  const [prev, setPrev] = useState(cards);
  if (prev !== cards) {
    const now = new Set(cards.map((c) => c.key));
    const gone = prev.slice(0, max).flatMap((c, index) => (now.has(c.key) ? [] : [{ card: c, index }]));
    setPrev(cards);
    if (gone.length) setLeaving((l) => [...l, ...gone]);
  }
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!leaving.length) return;
    const reduced = reducedMotion();
    const anims: Animation[] = [];
    for (const { card } of leaving) {
      const el = strip.current?.querySelector<HTMLElement>(`[data-strip="${CSS.escape(card.key)}"]`);
      if (!el || el.dataset.out) continue;
      el.dataset.out = "1";
      const w = el.getBoundingClientRect().width;
      anims.push(el.animate(
        reduced ? [{ opacity: 1 }, { opacity: 0 }] : [{ width: `${w}px`, marginRight: "0px", opacity: 1 }, { width: "0px", marginRight: "-16px", opacity: 0, offset: 1 }],
        { duration: reduced ? ms("--d-fade") : ms("--d-arrive"), easing: reduced ? "linear" : curve("--ease-move"), fill: "forwards" },
      ));
    }
    if (!anims.length) return;
    let live = true;
    void Promise.all(anims.map((a) => a.finished)).then(() => { if (live) setLeaving([]); }, () => {});
    return () => { live = false; };
  }, [leaving]);
  const shown: { c: WorkCard; out: boolean }[] = cards.slice(0, max).map((c) => ({ c, out: false }));
  for (const l of [...leaving].sort((a, b) => a.index - b.index)) shown.splice(Math.min(l.index, shown.length), 0, { c: l.card, out: true });
  const more = cards.length - Math.min(max, cards.length);
  return (
    <div ref={strip} className={`live-strip ${open ? "live-strip-back" : ""}`} aria-label="Live work">
      <span className="ls-lbl">Live work <span className="ls-n num"><Roll value={cards.length} /></span></span>
      {shown.map(({ c, out }) => (
        <span key={c.key} data-strip={c.key} className={`ls-item ${c.kind === "agent" ? "ls-item-fixed" : ""} ${out ? "" : "enter-fade"}`} aria-hidden={out || undefined}>
          {c.kind === "delegate" ? (
            <>
              {c.employee ? <Avatar name={c.employee.name} hue={c.employee.hue} size={18} /> : <Icon name="branch" size={14} />}
              <b>{c.employee ? firstName(c.employee.name) : "A colleague"}</b>
              <span className="ls-now trunc"><ChildNowShort runId={c.childRunId} /></span>
            </>
          ) : (
            <>
              <Icon name="layers" size={14} />
              <b>Sub-agent</b>
              <span className="ls-time num"><Roll value={minutes(c.task.durationMs)} /></span>
            </>
          )}
        </span>
      ))}
      {more > 0 ? <span className="ls-more">+{more} more</span> : null}
      <span className="grow" />
      <button type="button" className="btn btn-ghost btn-sm ls-show" onClick={onShow} aria-expanded={open}>Show <Icon name="chevronRight" size={13} /></button>
    </div>
  );
}

/** The sheet's scrim and frame, sliding in from the right edge of the conversation and back out the same way. */
export function WorkSheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const [shown, setShown] = useState(open);
  const sheet = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  if (open && !shown) setShown(true);
  useLayoutEffect(() => {
    const s = sheet.current, b = scrim.current;
    if (!shown || !s || !b) return;
    const reduced = reducedMotion();
    const o: KeyframeAnimationOptions = reduced ? { duration: ms("--d-fade"), easing: "linear", fill: "both" } : { duration: ms("--d-panel"), easing: curve("--ease"), fill: "both" };
    // Solid things do not fade through: the sheet slides in opaque; only the scrim fades.
    const slide = reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: "translateX(100%)" }, { transform: "none" }];
    const anims = [s.animate(slide, o), b.animate([{ opacity: 0 }, { opacity: 1 }], o)];
    if (!open) {
      anims.forEach((a) => a.reverse());
      let live = true;
      void Promise.all(anims.map((a) => a.finished)).then(() => { if (live) setShown(false); }, () => {});
      return () => { live = false; };
    }
    // Focus lands on the sheet itself, not its close button (whose tooltip would show), and moves nothing. On close it
    // goes back to what opened the sheet only if that was reached by keyboard, so a pressed chip shows no tooltip.
    const prev = document.activeElement as HTMLElement | null;
    const byKeyboard = !!prev?.matches(":focus-visible");
    s.focus({ preventScroll: true });
    return () => {
      if (s.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      if (prev?.isConnected && byKeyboard) prev.focus({ preventScroll: true });
    };
  }, [open, shown]);
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      // A keyboard close shows no tooltip: whatever has focus in the sheet lets go first.
      if (sheet.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  if (!shown) return null;
  return (
    <>
      <div ref={scrim} className="work-scrim" onClick={onClose} />
      <div ref={sheet} className="work-sheet-frame" tabIndex={-1} role="dialog" aria-label="Live work">{children}</div>
    </>
  );
}
