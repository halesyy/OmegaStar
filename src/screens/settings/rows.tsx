import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState,
  type ReactNode,
} from "react";
import { call, errorMessage } from "../../api/client";
import type { AppSettings } from "../../api/types";
import { refreshOrg, type Query } from "../../lib/hooks";
import { capitalize } from "../../lib/format";
import { curve, ms } from "../../lib/motion";
import { Icon } from "../../components/Icon";
import { Roll } from "../../components/ui";

// ---------------------------------------------------------------- saving, row by row
//
// A change saves at once and its own row says how it went: "Saving…" beside the title only when the save is slow,
// then "Saved" for a moment; a failure puts the control back and opens a line under the description with the reason
// and Try again. Rows are known by their title, which is unique on this page.

type SaveState = "saving" | "saved" | "failed";
type RowSave = { state: SaveState; message?: string; retry?: () => void };
export type Saves = {
  rows: Record<string, RowSave>;
  /** What the polite live region last said. */
  said: string;
  saving: (row: string) => void;
  saved: (row: string) => void;
  failed: (row: string, message: string, retry?: () => void) => void;
  clear: (row: string) => void;
};

/** How long "Saved" stays beside a row's title. */
const SAVED_MS = 1600;

export const SaveRows = createContext<Record<string, RowSave>>({});
export const useRowSave = (row: string): RowSave | undefined => useContext(SaveRows)[row];

/** A message from the app as a sentence: a capital first and a full stop last. */
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const s = capitalize(t);
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

export function useRowSaves(): Saves {
  const [rows, setRows] = useState<Record<string, RowSave>>({});
  const [said, setSaid] = useState("");
  const timers = useRef(new Map<string, number>());
  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => window.clearTimeout(t));
  }, []);
  const put = useCallback((row: string, next: RowSave | null) => {
    window.clearTimeout(timers.current.get(row));
    timers.current.delete(row);
    setRows((r) => {
      const { [row]: _gone, ...rest } = r;
      return next ? { ...rest, [row]: next } : rest;
    });
  }, []);
  return useMemo(() => ({
    rows,
    said,
    saving: (row) => put(row, { state: "saving" }),
    saved: (row) => {
      put(row, { state: "saved" });
      setSaid(`${row}: saved.`);
      timers.current.set(row, window.setTimeout(() => put(row, null), SAVED_MS));
    },
    failed: (row, message, retry) => {
      put(row, { state: "failed", message, retry });
      setSaid(`${row}: not saved. ${message}`);
    },
    clear: (row) => put(row, null),
  }), [rows, said, put]);
}

export type Change = (row: string, apply: (s: AppSettings) => AppSettings, then?: () => void) => void;
type Job = { row: string; apply: (s: AppSettings) => AppSettings; then?: () => void };

/**
 * Settings as they show (what was saved plus every change still on its way) and `change` to make one. Saves go one at
 * a time in the order made, each applied to what the app last confirmed, so a slow answer never brings an older value
 * back and a failed save undoes only its own change. `apply` must build from the settings it is given.
 */
export function useSettingsSaves(query: Query<AppSettings>, saves: Saves): { view: AppSettings | undefined; change: Change } {
  const queue = useRef<Job[]>([]);
  const busy = useRef(false);
  const confirmed = useRef<AppSettings | undefined>(undefined);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!busy.current && !queue.current.length) confirmed.current = query.data;
  }, [query.data]);

  const run = async (): Promise<void> => {
    const job = queue.current[0];
    const base = confirmed.current;
    if (busy.current || !job || !base) return;
    busy.current = true;
    const later = () => queue.current.some((j) => j.row === job.row);
    try {
      const saved = await call("save_settings", { settings: job.apply(base) });
      confirmed.current = saved;
      queue.current.shift();
      query.set(saved);
      if (!later()) saves.saved(job.row);
      refreshOrg();
      job.then?.();
    } catch (e) {
      queue.current.shift();
      if (!later()) saves.failed(job.row, sentence(errorMessage(e)), () => change(job.row, job.apply, job.then));
    } finally {
      busy.current = false;
      bump();
      void run();
    }
  };
  const change: Change = (row, apply, then) => {
    queue.current.push({ row, apply, then });
    saves.saving(row);
    bump();
    void run();
  };
  const view = query.data ? queue.current.reduce((s, j) => j.apply(s), query.data) : undefined;
  return { view, change };
}

// ---------------------------------------------------------------- the parts of a row

/** "Saving…" and "Saved" share one reserved slot beside the title, so the title never rewraps as they come and go.
 *  "Saving…" waits 400 ms, so a quick save shows only "Saved". */
function SaveMark({ state }: { state?: SaveState }) {
  return (
    <span className="set-mark" data-state={state ?? "idle"} aria-hidden>
      <span className="set-mark-saving">Saving…</span>
      <span className="set-mark-saved"><Icon name="check" size={12} />Saved</span>
    </span>
  );
}

/** A failed save: the reason in coral words and Try again, opening its own space under the description. */
export function FailLine({ id, save }: { id: string; save?: RowSave }) {
  const failed = save?.state === "failed";
  const [kept, setKept] = useState(save);
  if (failed && save !== kept) setKept(save);
  return (
    <div className="collapse" data-open={failed} inert={!failed}>
      <div>
        <p id={id} className="set-fail">
          <Icon name="alert" size={12} />
          <span>
            {kept?.message}
            {kept?.retry ? <button type="button" className="set-retry" onClick={kept.retry}>Try again</button> : null}
          </span>
        </p>
      </div>
    </div>
  );
}

/** One setting: what it is and what it does on the left, its control on the right, centred on the title's line so it
 *  never moves when the words beside it change. Its save shows beside the title and a failed save opens a line under
 *  the description. A field whose Save button reports for itself passes `mark={false}`; the proxy's fields, which are
 *  saved together at the foot, pass `fail={false}` too. */
export function Row({ title, desc, children, mark = true, fail = true }: {
  title: string; desc?: ReactNode; children?: ReactNode; mark?: boolean; fail?: boolean;
}) {
  const save = useRowSave(title);
  const ids = useId();
  const failed = fail && save?.state === "failed";
  const describedBy = [desc ? `${ids}d` : "", failed ? `${ids}f` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="set-row" role="group" aria-labelledby={`${ids}t`} aria-describedby={describedBy}>
      <div className="set-words">
        <div className="set-title-line">
          <span id={`${ids}t`} className="set-title">{title}</span>
          {mark ? <SaveMark state={save?.state} /> : null}
        </div>
        {desc ? <div id={`${ids}d`} className="set-desc">{desc}</div> : null}
        {fail ? <FailLine id={`${ids}f`} save={save} /> : null}
      </div>
      {children ? <div className="set-control">{children}</div> : null}
    </div>
  );
}

/** Words that follow a value: when `on` changes, the old words fade out where they were while the space eases to the
 *  new words' height and they fade in, so the rows below move with it instead of jumping. */
export function Swap({ on, children }: { on: string; children: ReactNode }) {
  const [shown, setShown] = useState(on);
  const [was, setWas] = useState<{ on: string; node: ReactNode } | null>(null);
  const last = useRef<ReactNode>(children);
  const box = useRef<HTMLSpanElement>(null);
  const height = useRef<number | null>(null);
  const changed = useRef(false);
  if (on !== shown) {
    changed.current = true;
    setWas({ on: shown, node: last.current });
    setShown(on);
  }
  useLayoutEffect(() => {
    last.current = children;
    const el = box.current;
    if (!el) return;
    const from = height.current;
    const to = el.offsetHeight;
    height.current = to;
    if (!changed.current) return;
    changed.current = false;
    // Growing, the new words wait until the height has nearly made their room; shrinking, they fit at once.
    el.style.setProperty("--swap-delay", from !== null && to > from ? `${Math.round(ms("--d-arrive") * 0.65)}ms` : "60ms");
    if (from !== null && from !== to) {
      el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: ms("--d-arrive"), easing: curve("--ease-move") });
    }
  });
  // The old words leave (and the new ones keep their fade) until the longest fade-in, delay and all, has finished.
  useEffect(() => {
    if (!was) return;
    const t = window.setTimeout(() => setWas(null), ms("--d-arrive") * 0.65 + ms("--d-ui") + 60);
    return () => window.clearTimeout(t);
  }, [was]);
  return (
    <span ref={box} className="set-swap">
      {was ? <span key={`was-${was.on}`} className="set-swap-out" aria-hidden>{was.node}</span> : null}
      <span key={`now-${on}`} className={was ? "set-swap-in" : undefined}>{children}</span>
    </span>
  );
}

/** A button's labels in one slot at the widest one's width: `at` picks which shows. */
export function States({ at, labels }: { at: number; labels: ReactNode[] }) {
  return (
    <span className="set-states" data-at={at}>
      {labels.map((l, i) => <span key={i} aria-hidden={i !== at || undefined}>{l}</span>)}
    </span>
  );
}

/** Save for a field: "Saving…", then "Saved" with a check, on the button itself. */
export function SaveButton({ state, disabled }: { state?: SaveState; disabled: boolean }) {
  const at = state === "saving" ? 1 : state === "saved" ? 2 : 0;
  return (
    <button className="btn set-save" type="submit" disabled={disabled || at > 0} data-state={state ?? "idle"}>
      <States at={at} labels={["Save", "Saving…", <><Icon name="check" size={12} />Saved</>]} />
    </button>
  );
}

/** An error on the field that caused it, opening its own space under the field. */
export function FieldError({ id, text }: { id: string; text: string | null }) {
  const [kept, setKept] = useState(text);
  if (text && text !== kept) setKept(text);
  return (
    <div className="collapse" data-open={!!text} inert={!text}>
      <div>
        <p id={id} className="field-error set-field-error"><Icon name="alert" size={12} />{kept}</p>
      </div>
    </div>
  );
}

export function Stepper({ label, value, min, max, less, more, onChange }: {
  label: string; value: number; min: number; max: number; less: string; more: string; onChange: (v: number) => void;
}) {
  return (
    <div className="set-stepper" role="group" aria-label={label}>
      <button type="button" aria-label={less} disabled={value <= min} onClick={() => onChange(value - 1)}><Icon name="minus" size={14} /></button>
      <span className="set-stepper-value num"><Roll value={value} /></span>
      <button type="button" aria-label={more} disabled={value >= max} onClick={() => onChange(value + 1)}><Icon name="plus" size={14} /></button>
    </div>
  );
}
