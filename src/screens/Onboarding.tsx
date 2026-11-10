// First run: set up your company inside the office's own frame. The ultramarine band is the shell's sidebar from the
// first second, folded to the rail so the page leads: the brand where the office has it, and your initials at its foot as
// you type. When the office opens, the band opens to the sidebar it will be, and only the page changes.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type Ref, type RefObject } from "react";
import { call, errorMessage } from "../api/client";
import type { SetupStatus } from "../api/types";
import { CopyCommand } from "../components/CopyCommand";
import { Icon } from "../components/Icon";
import { Avatar, ErrorNote, PageHeader, Roll, Section, Switch } from "../components/ui";
import { dragRegion, macChrome } from "../lib/chrome";
import { initials } from "../lib/format";
import { curve, ms, reducedMotion, usePresence } from "../lib/motion";
import { useScrollFade } from "../lib/scrollFade";
import { useOrg, refreshOrg } from "../lib/hooks";
import { railNow } from "../lib/sidebar";
import { SideBrand } from "../Shell";
import "./Onboarding.css";

/** What every employee should know, each under the company page section it goes in. */
const KNOW = [
  { section: "What we sell", label: "What we sell", placeholder: "e.g. Garden tools for small shops" },
  { section: "What we use", label: "What we use", placeholder: "e.g. Gmail, GitHub, Stripe" },
  { section: "How things work here", label: "How I like to work", placeholder: "e.g. Drafts before anything goes out" },
  { section: "Voice and style", label: "Voice", placeholder: "e.g. Plain and warm, no jargon" },
];

/** The company page with `line` at the end of `section`, which goes at the end when the page has none. A line already on it is left as it is. */
function withLine(page: string, section: string, line: string): string {
  const lines = page.split("\n");
  if (lines.some((l) => l.trim() === line)) return page;
  const head = lines.findIndex((l) => l.trim() === `## ${section}`);
  if (head < 0) return `${page.trimEnd()}\n\n## ${section}\n\n${line}\n`;
  let end = lines.findIndex((l, i) => i > head && l.startsWith("#"));
  if (end < 0) end = lines.length;
  while (end > head + 1 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, ...(lines[end - 1].startsWith("- ") ? [line] : ["", line]));
  return lines.join("\n");
}

/** A block that opens and closes its own space (`.collapse`); while closed nothing in it can be reached. */
function Collapse({ open, className, children }: { open: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={`collapse ${className ?? ""}`} data-open={open}>
      <div inert={!open}>{children}</div>
    </div>
  );
}

/** A word in its own slot (a status pinned right, a button label, the note). When it changes, the old word rolls up and
 *  is gone before it reaches the slot's edge, the new one rolls in, and the slot eases to the new width, so whatever
 *  sits beside it travels instead of jumping. The width holds until the old word is removed, so nothing re-measures
 *  for a frame in between. Under reduced motion the old word fades out, then the new one fades in. */
function Word({ value, align = "end" }: { value: string; align?: "start" | "end" }) {
  const [w, setW] = useState<{ value: string; from: string | null }>({ value, from: null });
  if (w.value !== value) setW({ value, from: w.value });
  const slot = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = slot.current;
    if (!el || w.from === null) return;
    const [out, inn] = [el.children[0] as HTMLElement, el.children[1] as HTMLElement];
    const reduced = reducedMotion();
    const d = reduced ? ms("--d-fade") : ms("--d-roll");
    const o: KeyframeAnimationOptions = { duration: d, easing: reduced ? "linear" : curve("--ease"), fill: "both" };
    const anims = reduced
      ? [
        out.animate([{ opacity: 1 }, { opacity: 0 }], { ...o, duration: d / 2 }),
        inn.animate([{ opacity: 0 }, { opacity: 1 }], { ...o, duration: d / 2, delay: d / 2 }),
      ]
      : [
        // Each word is see-through whenever it sits more than a sliver outside the slot, so the slot's edges never cut
        // a visible letter: the old one is gone by a tenth of its rise, the new one appears only in its last tenth.
        out.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(-10%)", opacity: 0, offset: 0.2 }, { transform: "translateY(-50%)", opacity: 0 }], o),
        inn.animate([{ transform: "translateY(50%)", opacity: 0 }, { transform: "translateY(10%)", opacity: 0, offset: 0.8 }, { transform: "none", opacity: 1 }], o),
      ];
    anims.push(el.animate([{ width: `${out.offsetWidth}px` }, { width: `${inn.offsetWidth}px` }], { duration: reduced ? 1 : d, easing: curve("--ease"), fill: "forwards" }));
    let live = true;
    void Promise.all(anims.map((a) => a.finished)).then(() => { if (live) setW((s) => ({ ...s, from: null })); }, () => {});
    return () => { live = false; anims.forEach((a) => a.cancel()); };
  }, [w.from]);
  return (
    <span ref={slot} className={`ob-word ob-word-${align}`}>
      {w.from !== null ? <><span aria-hidden>{w.from}</span><span>{w.value}</span></> : <span>{w.value}</span>}
    </span>
  );
}

/** A check's state in a word: coral with a still dot when it needs you, green with a tick when it's done. The word rolls
 *  and the mark turns in place; under reduced motion the old state fades out whole, then the new one fades in, so the
 *  mark, the colour and the word never disagree and never print over each other. */
function State({ ok, word }: { ok: boolean; word: string }) {
  const [x, setX] = useState<{ ok: boolean; word: string; from: { ok: boolean; word: string } | null }>({ ok, word, from: null });
  if (x.ok !== ok || x.word !== word) setX({ ok, word, from: reducedMotion() ? { ok: x.ok, word: x.word } : null });
  useEffect(() => {
    if (!x.from) return;
    const t = window.setTimeout(() => setX((s) => ({ ...s, from: null })), ms("--d-fade") * 2 + 40);
    return () => window.clearTimeout(t);
  }, [x.from]);
  const layer = (k: { ok: boolean; word: string }, motion: string, key: string) => (
    <span key={key} className={`status ob-state ${k.ok ? "status-ok" : "status-attn"} ${motion}`} aria-hidden={motion === "leave-fade" || undefined}>
      <span className="ob-mark" aria-hidden><i /><Icon name="check" size={12} strokeWidth={2} /></span>
      <Word value={k.word} />
    </span>
  );
  // Keys keep each layer its own element: one stable layer when the word rolls; under reduced motion, one per state, so
  // the layer fading out is never reused as the one that stays.
  return (
    <span className="ob-state-x">
      {x.from ? layer(x.from, "leave-fade", `was ${x.from.ok} ${x.from.word}`) : null}
      {layer(x, x.from ? "enter-fade ob-after-out" : "", reducedMotion() ? `now ${x.ok} ${x.word}` : "now")}
    </span>
  );
}

/** A button's label (and its icon) held in the footprint of its longest label, so the button never changes size: the
 *  words roll, and the label and icon stay together in the middle as the slot eases to the new width. */
function Held({ value, longest, icon }: { value: string; longest: string; icon?: ReactNode }) {
  return (
    <span className="ob-held">
      <span className="ob-held-size" aria-hidden>{longest}{icon}</span>
      <span className="ob-held-now"><Word value={value} />{icon}</span>
    </span>
  );
}

/** The cause in an error, without a leading "Couldn't …:" that the note's own title already says. */
function causeOf(message: string): string {
  const cause = message.replace(/^Couldn't [^:]*:\s*/, "");
  return cause.charAt(0).toUpperCase() + cause.slice(1);
}

/** The page as it stands, left behind for its exit: a still copy laid exactly over it that rises 8px and fades on the
 *  same clock and curve as the office's canvas rising in underneath (--d-swap, --ease), so the two dissolve evenly:
 *  no cut, no blank frame. Under reduced motion both are a linear crossfade over --d-fade. The copy keeps what was
 *  typed and where each area was scrolled, drops any word caught mid-roll, and can't be reached or read twice. */
function leaveAsGhost(main: HTMLElement) {
  const r = main.getBoundingClientRect();
  const ghost = main.cloneNode(true) as HTMLElement;
  ghost.querySelectorAll(".ob-word > [aria-hidden], .roll > [aria-hidden]").forEach((n) => n.remove());
  ghost.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  const [fromInputs, toInputs] = [main.querySelectorAll("input"), ghost.querySelectorAll("input")];
  fromInputs.forEach((f, i) => { toInputs[i].value = f.value; toInputs[i].checked = f.checked; });
  ghost.classList.remove("enter-rise");
  ghost.classList.add("ob-ghost");
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  Object.assign(ghost.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  document.body.appendChild(ghost);
  const [fromScroll, toScroll] = [main.querySelectorAll<HTMLElement>(".ob-scroll"), ghost.querySelectorAll<HTMLElement>(".ob-scroll")];
  fromScroll.forEach((f, i) => { toScroll[i].scrollTop = f.scrollTop; });
  const reduced = reducedMotion();
  const exit = ghost.animate(
    reduced ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: "0 -8px" }],
    { duration: reduced ? ms("--d-fade") : ms("--d-swap"), easing: reduced ? "linear" : curve("--ease"), fill: "forwards" },
  );
  let gone = false;
  const remove = () => { if (!gone) { gone = true; ghost.remove(); } };
  void exit.finished.then(remove, remove);
  window.setTimeout(remove, 800);
}

/** Where a short window cuts the form, the cut goes through a field's box, never a gap (the form would look finished)
 *  and never just under a row of labels (they would sit stranded on the edge). On load and on resize, the gap above the
 *  optional block and the foot's top padding give or take a few pixels so the edge crosses one of the optional block's
 *  fields between 30% and all of its height. Nothing moves while you work in the form. */
function useFoldThroughARow(page: RefObject<HTMLElement | null>, scroll: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const fit = () => {
      const [p, el] = [page.current, scroll.current];
      if (!p || !el) return;
      p.style.setProperty("--fold-gap", "0px");
      p.style.setProperty("--fold-foot", "0px");
      if (el.scrollTop > 0 || el.scrollHeight <= el.clientHeight + 1) return;
      const edge = el.getBoundingClientRect().bottom;
      const fields = [...el.querySelectorAll<HTMLElement>(".ob-know .input")].map((i) => i.getBoundingClientRect());
      // The shift (content down against the edge) that puts the edge closest to where it is, inside some field.
      let best: number | null = null;
      for (const f of fields) {
        const s = Math.min(Math.max(0, edge - f.bottom), edge - f.top - 0.3 * f.height);
        if (s >= edge - f.bottom && (best === null || Math.abs(s) < Math.abs(best))) best = s;
      }
      if (!best) return;
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
      const foot = clamp(best * 0.4, -8, 12);
      const gap = clamp(best - foot, -12, 24);
      if (Math.abs(gap + foot - best) > 1) return;
      p.style.setProperty("--fold-gap", `${gap}px`);
      p.style.setProperty("--fold-foot", `${foot}px`);
    };
    fit();
    void document.fonts?.ready.then(fit);
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [page, scroll]);
}

/** Your card as the org chart will draw it, filling in as you type: the office opens on this same card, with your first
 *  hire's place under it. Shown where the window has room beside the form. */
function YouPreview({ name, title, company }: { name: string; title: string; company: string }) {
  return (
    <aside className="ob-chart" aria-hidden>
      <span className="ob-chart-label">Your org chart</span>
      <div className="ob-node">
        {name ? <Avatar name={name} hue={0} size={32} you /> : <span className="ob-node-av" />}
        <span className="ob-node-text">
          <span className={`ob-node-name ${name ? "" : "ob-node-blank"}`}>{name || "Your name"}</span>
          <span className="ob-node-sub">{[title || "CEO", company].filter(Boolean).join(" · ")}</span>
          <span className="ob-node-you">You</span>
        </span>
      </div>
      <i className="ob-node-line" />
      <div className="ob-node-next">Your first hire</div>
    </aside>
  );
}

function Field({ label, hint, value, onChange, placeholder, error, inputRef, autoFocus, readOnly, wide }: {
  label: string; hint?: string; value: string; onChange: (v: string) => void; placeholder?: string;
  /** The message shown under the field while `error` is on: [on, message]. */
  error?: [boolean, string]; inputRef?: Ref<HTMLInputElement>; autoFocus?: boolean; readOnly?: boolean; wide?: boolean;
}) {
  const id = useId();
  return (
    <div className={`field ${wide ? "ob-wide" : ""}`}>
      <label className="field-label" htmlFor={id}>{label}{hint ? <span className="hint">{hint}</span> : null}</label>
      <input
        id={id} ref={inputRef} className="input" value={value} placeholder={placeholder} autoFocus={autoFocus} readOnly={readOnly}
        aria-invalid={error?.[0] || undefined} aria-describedby={error?.[0] ? `${id}-err` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <Collapse open={error[0]} className="ob-err">
          <span className="field-error" id={`${id}-err`}><Icon name="alert" size={12} /> {error[1]}</span>
        </Collapse>
      ) : null}
    </div>
  );
}

/** Claude Code and its sign-in. One line when both are fine; otherwise only the next thing to do, with its command. */
function ClaudeCode({ status, checking, error, onCheck }: { status: SetupStatus; checking: boolean; error: string | null; onCheck: () => void }) {
  const found = status.claude.found;
  const account = status.account;
  const signedIn = found && !!account?.loggedIn;
  const ready = found && signedIn;
  // The sign-in row closes as it was when everything turns ready, so a row on its way out never changes its words
  // (only its own state, Signed out to Signed in, which is the news).
  const [rowFound, setRowFound] = useState(found);
  if (!ready && rowFound !== found) setRowFound(found);
  // Only what arrives after the page opens fades in; what was there from the start is simply there.
  const [was] = useState({ found, ready });
  const arrives = (there: boolean) => (there ? "" : "ob-after enter-fade");
  const check = (
    <button type="button" className="btn ob-check" disabled={checking} onClick={onCheck}>
      <Held value={checking ? "Checking…" : "Check again"} longest="Check again" />
    </button>
  );
  return (
    <div className="ob-cc" aria-live="polite">
      <div className="ob-row">
        <div className="ob-row-head">
          <span className="ob-row-title">
            <span data-tip={found && status.claude.path ? status.claude.path : undefined}>Claude Code</span>
            {found && status.claude.version ? <span className={`ob-ver ${arrives(was.found)}`}>{status.claude.version}</span> : null}
            {ready ? (
              <span className={`ob-acct ${arrives(was.ready)}`}>
                <span className="ob-sep" aria-hidden>·</span>
                <span className="ob-trunc">{account?.email ? `signed in as ${account.email}` : "signed in"}</span>
              </span>
            ) : null}
            {ready && account?.plan ? <span className={`tag ${arrives(was.ready)}`}>{account.plan}</span> : null}
          </span>
          <State ok={found} word={ready ? "Ready" : found ? "Installed" : "Not installed"} />
        </div>
        <Collapse open={!found} className="ob-body">
          <div className="ob-body-in">
            <p className="ob-line">Run this in a terminal to install it, then come back here.</p>
            <div className="ob-act"><CopyCommand command="npm install -g @anthropic-ai/claude-code" />{check}</div>
          </div>
        </Collapse>
      </div>
      <Collapse open={!ready}>
        <div className="ob-row ob-row-next">
          <div className="ob-row-head">
            <span className={`ob-row-title ${rowFound ? "" : "ob-waiting"}`}><Roll value={rowFound ? "Claude account" : "Next: sign in to Claude Code"} /></span>
            {rowFound ? <span className={was.found ? "" : "enter-fade"}><State ok={signedIn} word={signedIn ? "Signed in" : "Signed out"} /></span> : null}
          </div>
          <Collapse open={found && !signedIn} className="ob-body">
            <div className="ob-body-in">
              <p className="ob-line">Run this in a terminal and follow the browser prompt.</p>
              <div className="ob-act"><CopyCommand command="claude auth login" />{check}</div>
            </div>
          </Collapse>
        </div>
      </Collapse>
      <Collapse open={!!error}>
        <p className="field-error ob-cc-err" role="alert"><Icon name="alert" size={12} /> {error}</p>
      </Collapse>
    </div>
  );
}

export function Onboarding({ initial, onDone }: { initial: SetupStatus; onDone: (s: SetupStatus) => void }) {
  const [status, setStatus] = useState(initial);
  const [company, setCompany] = useState("");
  const [ceo, setCeo] = useState("");
  const [title, setTitle] = useState("");
  const [know, setKnow] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState({ company: false, ceo: false });
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [bgErr, setBgErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  // The new company, once it exists. Then the band opens (when the office's sidebar is the full one), the page leaves,
  // and the office takes over.
  const [handOff, setHandOff] = useState<SetupStatus | null>(null);
  const [opening, setOpening] = useState(false);
  const [landed, setLanded] = useState(false);
  const [fails, setFails] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const { snap } = useOrg();
  const formId = useId();
  // The create error keeps its words while its note closes.
  const lastErr = useRef("");
  if (createErr) lastErr.current = createErr;
  const scroll = useScrollFade<HTMLDivElement>();
  useFoldThroughARow(pageRef, scroll);
  const companyRef = useRef<HTMLInputElement>(null);
  const ceoRef = useRef<HTMLInputElement>(null);

  const found = status.claude.found;
  const ready = found && (status.account?.loggedIn ?? false);
  const known = KNOW.filter((k) => (know[k.section] ?? "").trim());

  // One check at a time, whether it was asked for or came from returning to the window.
  const checkingNow = useRef(false);
  const recheck = useCallback(async () => {
    if (checkingNow.current) return;
    checkingNow.current = true;
    setChecking(true);
    setCheckErr(null);
    try { setStatus(await call("setup_status")); } catch (e) { setCheckErr(errorMessage(e)); } finally { checkingNow.current = false; setChecking(false); }
  }, []);
  // A check that passes closes the block its Check again button was in, which drops the focus; hand it to the next
  // thing to do: the other check's button, or the company's name once both are done.
  const checked = useRef({ found, ready });
  useEffect(() => {
    // Only when a check changes; on load nothing takes focus while Claude Code is missing, so the command leads.
    if (checked.current.found === found && checked.current.ready === ready) return;
    checked.current = { found, ready };
    if (document.activeElement && document.activeElement !== document.body) return;
    const next = ready ? companyRef.current : [...document.querySelectorAll<HTMLButtonElement>(".ob-check")].find((b) => !b.closest("[inert]"));
    next?.focus();
  }, [found, ready]);
  // While something is missing, coming back to Omega Star (from the terminal or the browser sign-in) checks again.
  useEffect(() => {
    if (ready) return;
    const again = () => void recheck();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [ready, recheck]);

  const setBackground = async (enabled: boolean) => {
    setBgErr(null);
    setStatus((s) => ({ ...s, background: enabled }));
    try {
      const s = await call("set_background", { enabled });
      setStatus((p) => ({ ...p, background: s.background }));
    } catch (e) {
      // The switch goes back to where it was: it never shows a setting that didn't save.
      setStatus((s) => ({ ...s, background: !enabled }));
      setBgErr(errorMessage(e));
    }
  };

  const creating = useRef(false);
  const create = async () => {
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    setCreateErr(null);
    try {
      // Before setup completes, so trying again after a failure adds nothing twice.
      if (known.length > 0) {
        const page = (await call("company_page")).text;
        const text = known.reduce((p, k) => withLine(p, k.section, `- ${know[k.section].trim()}`), page);
        if (text !== page) await call("save_company_page", { text });
      }
      const c = await call("complete_setup", { companyName: company.trim(), ceoName: ceo.trim(), title: title.trim() || null });
      // The office's data starts loading now, so its sidebar, your row and the chart are there in its first frame.
      refreshOrg();
      setHandOff({ ...status, company: c });
    } catch (e) {
      setCreateErr(errorMessage(e));
      setFails((n) => n + 1);
      setBusy(false);
      creating.current = false;
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    const miss = { company: !company.trim(), ceo: !ceo.trim() };
    if (miss.company || miss.ceo) {
      setMissing(miss);
      (miss.company ? companyRef : ceoRef).current?.focus();
      return;
    }
    void create();
  };

  // The hand-off. If the office's sidebar is the full one at this size, the band opens to it first, the page staying put.
  // Once the band has landed and the office's data is in, the page leaves as a still copy that rises and fades over the
  // office, whose chart rises in underneath: the two overlap, so nothing is cut and nothing is blank.
  const done = useRef(onDone);
  done.current = onDone;
  const handed = useRef(false);
  useEffect(() => {
    if (!handOff) return;
    const open = !railNow();
    setOpening(open);
    const t = window.setTimeout(() => setLanded(true), open ? ms("--d-panel") : 0);
    return () => window.clearTimeout(t);
  }, [handOff]);
  useEffect(() => {
    if (!handOff || !landed || handed.current) return;
    const over = () => {
      if (handed.current) return;
      handed.current = true;
      if (mainRef.current) leaveAsGhost(mainRef.current);
      done.current(handOff);
    };
    if (snap) { over(); return; }
    // Should the office's data be slow, it still opens; the shell shows its own loading.
    const t = window.setTimeout(over, 600);
    return () => window.clearTimeout(t);
  }, [handOff, landed, snap]);

  // A field that takes focus under either faded edge is scrolled just clear of it, ring and all; a field already in
  // view never moves. (The browser does the same through scroll-padding; this also covers scrolls it didn't make.)
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const clear = (e: FocusEvent) => {
      const t = e.target as HTMLElement;
      const [v, r, room] = [el.getBoundingClientRect(), t.getBoundingClientRect(), 20];
      if (r.bottom > v.bottom - room) el.scrollTop += r.bottom - (v.bottom - room);
      else if (r.top < v.top + room) el.scrollTop -= v.top + room - r.top;
    };
    el.addEventListener("focusin", clear);
    return () => el.removeEventListener("focusin", clear);
  }, [scroll]);

  // When the error opens its space in the foot, the column keeps its foot edge where it was against the content: what
  // was just above the edge rides up with it, so the edge never slices a row.
  useEffect(() => {
    if (!createErr) return;
    const el = scroll.current;
    if (!el) return;
    let h = el.clientHeight;
    let raf = 0;
    const until = performance.now() + ms("--d-arrive") + 160;
    const step = () => {
      const now = el.clientHeight;
      if (now !== h) { el.scrollTop += h - now; h = now; }
      if (performance.now() < until) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [createErr, fails, scroll]);

  // Your row at the band's foot: it arrives with your name and keeps its last words while it leaves.
  const name = ceo.trim();
  const you = useRef({ name: "", sub: "" });
  if (name) you.current = { name, sub: [title.trim() || "CEO", company.trim()].filter(Boolean).join(" · ") };
  const showYou = usePresence(!!name, 160);

  const note = !found ? "Install Claude Code first" : !ready ? "Sign in to Claude Code first" : createErr ? "" : "Next, you'll hire your first employee.";
  // While Claude Code is missing or signed out, the command leads; the first field takes focus only once it can be used.
  const [focusFirst] = useState(ready);

  return (
    <div className={`ob ${opening ? "ob-open" : "ob-rail"}`}>
      {macChrome ? <div className="side-chrome" {...dragRegion} /> : null}
      <aside className="ob-side" aria-label="Sidebar">
        <div className="side-top"><SideBrand /></div>
        <div className="ob-side-foot">
          {showYou ? (
            <div className={`side-you ${name ? "enter-drop" : "leave-fade"}`} aria-hidden>
              <span className="side-you-av"><span className="av-i">{initials(you.current.name)}</span></span>
              <span className="side-you-text">
                <span className="side-you-name">{you.current.name}</span>
                <span className="side-you-sub">{you.current.sub}</span>
              </span>
            </div>
          ) : null}
        </div>
      </aside>
      <main ref={mainRef} className="ob-main enter-rise">
        <div ref={pageRef} className="pagecol ob-page">
          {/* The title and its one-line intro hold still; only the form under them scrolls. */}
          <div className="ob-top">
            <PageHeader title="Set up your company" />
            <p className="ob-lead">Omega Star turns the Claude Code on this computer into a company you run. Name it and you're in.</p>
          </div>
          <div ref={scroll} className="pagecol-scroll scroll-fade ob-scroll">
            <div className="ob-stage">
              {/* The foot sits outside the form, so Open your office (attached by `form`) is its only submit button: Enter
                  in any field presses it, never a button that happens to come first. */}
              <form id={formId} className="pagecol-inner ob-inner" onSubmit={submit} noValidate aria-busy={busy}>
                <ClaudeCode status={status} checking={checking} error={checkErr} onCheck={() => void recheck()} />

                <div className="ob-fields">
                  <Field
                    wide label="Company" value={company} placeholder="e.g. Kestrel Labs" inputRef={companyRef} autoFocus={focusFirst} readOnly={busy}
                    onChange={(v) => { setCompany(v); setMissing((m) => ({ ...m, company: false })); }}
                    error={[missing.company, "Your company needs a name"]}
                  />
                  <Field
                    label="Your name" value={ceo} placeholder="e.g. Robin Ahn" inputRef={ceoRef} readOnly={busy}
                    onChange={(v) => { setCeo(v); setMissing((m) => ({ ...m, ceo: false })); }}
                    error={[missing.ceo, "Add your name"]}
                  />
                  <Field label="Your title" hint="CEO if blank" value={title} placeholder="e.g. Founder" readOnly={busy} onChange={setTitle} />
                </div>

                {/* The setting sits with what you must answer; the optional block comes last, so a short window cuts
                    through it and the page plainly carries on. */}
                <div className="ob-bg">
                  <div className="ob-bg-row">
                    <div className="ob-bg-text">
                      <span className="ob-bg-title">Start Omega Star at login</span>
                      <span className="ob-line">Schedules only run while Omega Star is open. It waits quietly in the tray.</span>
                    </div>
                    <Switch checked={status.background} disabled={busy} onChange={(v) => void setBackground(v)} label="Start Omega Star at login" />
                  </div>
                  <Collapse open={!!bgErr}>
                    <p className="field-error ob-bg-err" role="alert"><Icon name="alert" size={12} /> {bgErr}</p>
                  </Collapse>
                </div>

                <Section className="ob-know" title="What should every employee know?" action={<span className="ob-optional">Optional</span>}>
                  <p className="field-help ob-help">It goes on the company page, which every employee reads. Change it any time under You.</p>
                  <div className="ob-fields">
                    {KNOW.map((k) => (
                      <Field
                        key={k.section} label={k.label} value={know[k.section] ?? ""} placeholder={k.placeholder} readOnly={busy}
                        onChange={(v) => setKnow((s) => ({ ...s, [k.section]: v }))}
                      />
                    ))}
                  </div>
                </Section>
              </form>
              <YouPreview name={ceo.trim()} title={title.trim()} company={company.trim()} />
            </div>
          </div>

          <div className="ob-foot-wrap">
            <div className="ob-foot">
              {/* One action when creating fails: Open your office, beside it, tries again. The note opens its space, then
                  drops in whole; a new failure drops a new note. */}
              <Collapse open={!!createErr} className="ob-foot-err">
                {fails > 0 ? (
                  <ErrorNote
                    key={fails}
                    title={`Couldn't set up ${company.trim() || "your company"}`}
                    text={`${causeOf(lastErr.current)} Your answers are still here.`}
                  />
                ) : null}
              </Collapse>
              <div className="ob-go-row">
                <button type="submit" form={formId} className="btn btn-primary btn-lg ob-go" disabled={!ready} aria-disabled={busy || undefined}>
                  <Held value={busy || handOff ? "Opening…" : createErr ? "Try again" : "Open your office"} longest="Open your office" icon={<Icon name="arrowRight" size={15} />} />
                </button>
                <span className="ob-note" aria-live="polite"><Word value={note} align="start" /></span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
