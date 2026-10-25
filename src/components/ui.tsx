import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Presence, Run } from "../api/types";
import { initials, skillsChanged } from "../lib/format";
import { dismissToast, useToasts } from "../lib/toasts";
import { applyPanelWidth, PANEL_MIN, panelMax, setPanelWidth } from "../lib/panelWidth";
import { Icon, type IconName } from "./Icon";
import "./ui.css";

// ---------------------------------------------------------------- Avatar

export function Avatar({ name, hue, size = 36, presence, person = false, className }: {
  name: string; hue: number; size?: number; presence?: Presence; person?: boolean; className?: string;
}) {
  const style = { "--h": hue, width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) } as React.CSSProperties;
  return (
    <span className={`av ${person ? "av-person" : ""} ${presence ? `av-${presence}` : ""} ${className ?? ""}`} style={style} aria-hidden>
      {initials(name)}
      {presence === "attention" ? <span className="av-flag" /> : null}
    </span>
  );
}

// ---------------------------------------------------------------- Slide-over

export function SlideOver({ open, onClose, width = "var(--panel-w)", children, label, modal = false }: {
  open: boolean; onClose: () => void; width?: number | string; children: ReactNode; label: string; modal?: boolean;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (open) {
      lastFocus.current = document.activeElement;
      setMounted(true);
      const t = window.setTimeout(() => setShown(true), 20);
      return () => window.clearTimeout(t);
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), 260);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        const t = e.target as HTMLElement | null;
        if (t?.closest("[data-esc-stop]")) return;
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (shown && ref.current && !ref.current.contains(document.activeElement)) {
      const first = ref.current.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current;
      first.focus({ preventScroll: true });
    }
  }, [shown]);

  useEffect(() => {
    if (!open && lastFocus.current instanceof HTMLElement) lastFocus.current.focus({ preventScroll: true });
  }, [open]);

  if (!mounted) return null;
  return (
    <>
      {modal ? <div className={`scrim ${shown ? "scrim-on" : ""}`} onClick={onClose} /> : null}
      <aside
        ref={ref} tabIndex={-1} role="dialog" aria-label={label} aria-modal={modal || undefined}
        className={`slideover ${shown ? "slideover-on" : ""} ${modal ? "slideover-modal" : ""}`} style={{ width }}
      >
        {children}
        {modal ? null : <PanelEdge />}
      </aside>
    </>
  );
}

// The member panel's left edge: drag (or arrow keys) to resize it, double-click to go back to the default width.
function PanelEdge() {
  const edge = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>();
  const drag = useRef<{ x: number; from: number; to: number } | null>(null);
  const panelWidth = () => edge.current?.parentElement?.offsetWidth ?? PANEL_MIN;
  useLayoutEffect(() => { setWidth(panelWidth()); }, []);
  const clamp = (px: number) => Math.round(Math.min(panelMax(), Math.max(PANEL_MIN, px)));
  const save = (px: number | null) => { setPanelWidth(px); setWidth(panelWidth()); };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.documentElement.removeAttribute("data-resizing");
    if (d.to !== d.from) save(d.to);
  };
  return (
    <div
      ref={edge} className="slideover-edge" role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
      aria-valuenow={width} aria-valuemin={PANEL_MIN} aria-valuemax={panelMax()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const w = panelWidth();
        drag.current = { x: e.clientX, from: w, to: w };
        document.documentElement.setAttribute("data-resizing", "");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.to = clamp(d.from + d.x - e.clientX);
        applyPanelWidth(d.to);
      }}
      onPointerUp={end} onLostPointerCapture={end}
      onDoubleClick={() => save(null)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const step = (e.shiftKey ? 64 : 16) * (e.key === "ArrowLeft" ? 1 : -1);
        save(clamp(panelWidth() + step));
      }}
    />
  );
}

// ---------------------------------------------------------------- Inline confirm

export function ConfirmButton({ label, confirmLabel, question, onConfirm, icon, className = "btn btn-danger", size = "" }: {
  label: string; confirmLabel: string; question?: string; onConfirm: () => void | Promise<void>; icon?: IconName; className?: string; size?: "" | "btn-sm";
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (asking) yes.current?.focus(); }, [asking]);
  if (!asking) {
    return (
      <button type="button" className={`${className} ${size}`} onClick={() => setAsking(true)}>
        {icon ? <Icon name={icon} size={14} /> : null}
        {label}
      </button>
    );
  }
  return (
    <span className="confirm" data-esc-stop onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setAsking(false); } }}>
      {question ? <span className="confirm-q">{question}</span> : null}
      <button type="button" className={`btn btn-ghost ${size}`} onClick={() => setAsking(false)} disabled={busy}>Keep</button>
      <button
        ref={yes} type="button" className={`btn btn-danger-solid ${size}`} disabled={busy}
        onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); setAsking(false); } }}
      >
        {confirmLabel}
      </button>
    </span>
  );
}

// ---------------------------------------------------------------- Popover

export function Popover({ anchor, open, onClose, children, align = "end", width = 320 }: {
  anchor: React.RefObject<HTMLElement | null>; open: boolean; onClose: () => void; children: ReactNode; align?: "start" | "end"; width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const left = align === "end" ? Math.max(8, r.right - width) : Math.min(window.innerWidth - width - 8, r.left);
    setPos({ top: r.bottom + 6, left });
  }, [open, anchor, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); anchor.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey, true); };
  }, [open, onClose, anchor]);

  if (!open || !pos) return null;
  return createPortal(
    <div ref={ref} className="popover" style={{ top: pos.top, left: pos.left, width }} role="dialog">
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- Overlay

/** Something seen full-window (an image, a page) on a dark scrim. Escape, the close button or a click on the scrim
 *  closes it; `onKey` gets the other keys first. */
export function Overlay({ label, onClose, onKey, children }: {
  label: string; onClose: () => void; onKey?: (e: KeyboardEvent) => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, onKey });
  latest.current = { onClose, onKey };
  useEffect(() => {
    const last = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return latest.current.onKey?.(e);
      e.preventDefault();
      e.stopPropagation();
      latest.current.onClose();
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      if (last instanceof HTMLElement) last.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div ref={ref} className="overlay" role="dialog" aria-modal aria-label={label} tabIndex={-1} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {children}
      <button className="overlay-close" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- Toasts

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.tone === "ok" ? <Icon name="checkCircle" size={14} /> : t.tone === "err" ? <Icon name="alert" size={14} /> : null}
          <span>{t.text}</span>
          {t.action ? <button className="toast-action" onClick={() => { t.action?.run(); dismissToast(t.id); }}>{t.action.label}</button> : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Switch

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

// ---------------------------------------------------------------- Tabs

export function Tabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: { id: T; label: string; badge?: number | string | null }[]; value: T; onChange: (t: T) => void; className?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = refs.current.get(value);
    if (el) setBar({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value, tabs.length]);
  return (
    <div className={`tabs ${className ?? ""}`} role="tablist">
      {tabs.map((t, i) => (
        <button
          key={t.id} role="tab" aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1}
          ref={(el) => { if (el) refs.current.set(t.id, el); }}
          className="tab" onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
            onChange(next.id);
            refs.current.get(next.id)?.focus();
          }}
        >
          {t.label}
          {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
        </button>
      ))}
      {bar ? <span className="tabs-bar" style={{ transform: `translateX(${bar.left}px)`, width: bar.width }} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- page layout

/** A page's one header row: its title, and the actions that belong to this page only. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="pagehead">
      <h1 className="pagehead-title">{title}</h1>
      {children ? <div className="pagehead-actions">{children}</div> : null}
    </header>
  );
}

/** The one content column every page but the Org chart uses: a header that stays put over a column that scrolls. */
export function PageColumn({ title, actions, children, className }: { title: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`pagecol ${className ?? ""}`}>
      <PageHeader title={title}>{actions}</PageHeader>
      <div className="pagecol-scroll">
        <div className="pagecol-inner">{children}</div>
      </div>
    </div>
  );
}

/** A plain titled section inside a page or panel: a quiet heading, no card. */
export function Section({ title, count, action, children, id, className }: {
  title: ReactNode; count?: number | null; action?: ReactNode; children: ReactNode; id?: string; className?: string;
}) {
  return (
    <section className={`psec ${className ?? ""}`} id={id}>
      <header className="psec-head">
        <h2 className="psec-title">{title}{count ? <span className="psec-count num">{count}</span> : null}</h2>
        {action ? <div className="psec-action">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

export type MenuItem = { label: string; icon?: IconName; onSelect: () => void; disabled?: boolean; danger?: boolean };

/** A "More" button whose menu holds the actions that do not need to be on screen all the time. */
export function MenuButton({ items, label = "More actions", size = "btn-sm" }: { items: MenuItem[]; label?: string; size?: "" | "btn-sm" }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
  }, [open]);
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <>
      <button ref={anchor} type="button" className={`btn btn-ghost btn-icon ${size}`} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" size={14} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={236}>
        <div
          ref={list} className="menu" role="menu" aria-label={label} data-esc-stop
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const btns = [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
            const i = btns.indexOf(document.activeElement as HTMLButtonElement);
            btns[(i + (e.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length]?.focus();
          }}
        >
          {shown.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={`menu-item ${it.danger ? "menu-item-danger" : ""}`} disabled={it.disabled}
              onClick={() => { setOpen(false); it.onSelect(); }}>
              {it.icon ? <Icon name={it.icon} size={13} /> : null}{it.label}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------- misc

export function ErrorNote({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="error-note" role="alert">
      <Icon name="alert" size={14} />
      <span className="grow">{text}</span>
      {onRetry ? <button className="btn btn-sm" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

export function Skeleton({ h = 14, w = "100%", r = 6 }: { h?: number; w?: number | string; r?: number }) {
  return <span className="skeleton" style={{ display: "block", height: h, width: w, borderRadius: r }} />;
}

/** The chip under a report naming the skills the run changed, so the report itself need not say so. */
export function SkillsGrew({ run }: { run: Pick<Run, "skillChanges"> }) {
  const g = skillsChanged(run.skillChanges);
  return <span className="report-grew" title={g.title}><Icon name="sparkle" size={12} /> {g.label}</span>;
}

export function StatePill({ tone, children, pulse }: { tone: "accent" | "ok" | "warn" | "err" | "neutral"; children: ReactNode; pulse?: boolean }) {
  return (
    <span className={`pill ${tone === "neutral" ? "" : tone === "accent" ? "pill-live" : `pill-${tone}`} state-pill`}>
      <span className={`state-dot ${pulse ? "state-dot-pulse" : ""}`} />
      {children}
    </span>
  );
}
