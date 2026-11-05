import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState,
  type CSSProperties, type ReactNode, type RefObject,
} from "react";
import { call, errorMessage } from "../api/client";
import type {
  AppSettings, BackupFrequency, BackupSettings, BackupStatus, BuildChannel, BusinessHours, CheckFrequency, IsoWeekday, NotificationSettings, NotifyMode,
  ProxySettings, QuietHours, SetupStatus, WatchSettings,
} from "../api/types";
import { refreshOrg, rescanSkills, useQuery, useSkillScan, type Query, type SkillScan } from "../lib/hooks";
import { clockHM, relTime, whenShort } from "../lib/format";
import { curve, ms, reducedMotion, usePresence } from "../lib/motion";
import { setTheme, useTheme, type ThemePref } from "../lib/theme";
import { CopyCommand } from "../components/CopyCommand";
import { Icon } from "../components/Icon";
import { ErrorNote, PageColumn, Roll, Section, Skeleton, Switch } from "../components/ui";
import { openHelp } from "../lib/help";
import { checkForUpdate, useUpdateCheck } from "../lib/update";
import "./Settings.css";

// ---------------------------------------------------------------- saving, row by row
//
// A change saves at once and its own row says how it went: "Saving…" beside the title only when the save is slow,
// then "Saved" for a moment; a failure puts the control back and opens a line under the description with the reason
// and Try again. Rows are known by their title, which is unique on this page.

type SaveState = "saving" | "saved" | "failed";
type RowSave = { state: SaveState; message?: string; retry?: () => void };
type Saves = {
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

const SaveRows = createContext<Record<string, RowSave>>({});
const useRowSave = (row: string): RowSave | undefined => useContext(SaveRows)[row];

/** A message from the app as a sentence: a capital first and a full stop last. */
function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const s = t[0].toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

function useRowSaves(): Saves {
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

type Change = (row: string, apply: (s: AppSettings) => AppSettings, then?: () => void) => void;
type Job = { row: string; apply: (s: AppSettings) => AppSettings; then?: () => void };

/**
 * Settings as they show (what was saved plus every change still on its way) and `change` to make one. Saves go one at
 * a time in the order made, each applied to what the app last confirmed, so a slow answer never brings an older value
 * back and a failed save undoes only its own change. `apply` must build from the settings it is given.
 */
function useSettingsSaves(query: Query<AppSettings>, saves: Saves): { view: AppSettings | undefined; change: Change } {
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
function FailLine({ id, save }: { id: string; save?: RowSave }) {
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
function Row({ title, desc, children, mark = true, fail = true, className }: {
  title: string; desc?: ReactNode; children?: ReactNode; mark?: boolean; fail?: boolean; className?: string;
}) {
  const save = useRowSave(title);
  const ids = useId();
  const failed = fail && save?.state === "failed";
  const describedBy = [desc ? `${ids}d` : "", failed ? `${ids}f` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`set-row ${className ?? ""}`} role="group" aria-labelledby={`${ids}t`} aria-describedby={describedBy}>
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
function Swap({ on, children }: { on: string; children: ReactNode }) {
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
function States({ at, labels }: { at: number; labels: ReactNode[] }) {
  return (
    <span className="set-states" data-at={at}>
      {labels.map((l, i) => <span key={i} aria-hidden={i !== at || undefined}>{l}</span>)}
    </span>
  );
}

/** Save for a field: "Saving…", then "Saved" with a check, on the button itself. */
function SaveButton({ state, disabled }: { state?: SaveState; disabled: boolean }) {
  const at = state === "saving" ? 1 : state === "saved" ? 2 : 0;
  return (
    <button className="btn set-save" type="submit" disabled={disabled || at > 0} data-state={state ?? "idle"}>
      <States at={at} labels={["Save", "Saving…", <><Icon name="check" size={12} />Saved</>]} />
    </button>
  );
}

/** An error on the field that caused it, opening its own space under the field. */
function FieldError({ id, text }: { id: string; text: string | null }) {
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

function Stepper({ label, value, min, max, less, more, onChange }: {
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

// ---------------------------------------------------------------- sections

const SECTIONS = ["Claude Code", "Running", "Notifications", "Replies from people", "Appearance", "Data and backups", "CLI proxy", "About"] as const;
type SectionName = (typeof SECTIONS)[number];
const secId = (t: SectionName) => `set-${t.toLowerCase().replace(/[^a-z]+/g, "-")}`;

/** A section: its title (and a link beside it), an optional line on what it is for, its rows, then a note. */
function Group({ title, sub, action, foot, children }: { title: SectionName; sub?: string; action?: ReactNode; foot?: ReactNode; children: ReactNode }) {
  return (
    <Section title={title} action={action} id={secId(title)} className="set-sec">
      {sub ? <p className="set-sub">{sub}</p> : null}
      <div className="set-list">{children}</div>
      {foot}
    </Section>
  );
}

/** The sections by name beside the page on wide windows; the one you are reading is marked, and a click goes there. */
function SectionIndex({ host }: { host: RefObject<HTMLDivElement | null> }) {
  const [at, setAt] = useState(0);
  const pinned = useRef(false);
  const idle = useRef<number | undefined>(undefined);
  // A click marks its section at once and holds it while the page scrolls there.
  const settle = useCallback(() => {
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => { pinned.current = false; }, 160);
  }, []);
  useEffect(() => {
    const root = host.current;
    const scroller = root?.closest<HTMLElement>(".pagecol-scroll");
    if (!root || !scroller) return;
    const update = () => {
      if (pinned.current) return settle();
      // The section whose title has passed a line a quarter of the way down; at the end of the page the last one.
      const secs = [...root.querySelectorAll<HTMLElement>(".set-main > .set-sec")];
      const end = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.25;
      let i = 0;
      secs.forEach((el, n) => { if (el.getBoundingClientRect().top <= line) i = n; });
      setAt(end ? secs.length - 1 : i);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => { scroller.removeEventListener("scroll", update); window.clearTimeout(idle.current); };
  }, [host, settle]);
  const go = (i: number) => {
    pinned.current = true;
    settle();
    setAt(i);
    document.getElementById(secId(SECTIONS[i]))?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
  };
  return (
    <nav className="set-index" aria-label="Settings sections">
      <span className="set-index-bar" style={{ "--at": at } as CSSProperties} aria-hidden />
      {SECTIONS.map((t, i) => (
        <button key={t} type="button" className="set-index-item" aria-current={i === at ? "location" : undefined} onClick={() => go(i)}>{t}</button>
      ))}
    </nav>
  );
}

/** What loading stands in for: the first four sections' own rows (a title, each line of description, and the
 *  control's blocks as [width, height, radius], with a second line of blocks for Business hours), so the page lands
 *  where the skeleton was and the skeleton runs off the bottom at every size. */
type Block = [number, number, number];
const LOADING: { head: number; link?: number; sub?: number[]; rows: { t: number; d: number[]; c: Block[]; c2?: Block[] }[] }[] = [
  { head: 104, link: 116, rows: [
    { t: 78, d: [214], c: [[76, 22, 11]] },
    { t: 98, d: [252], c: [[260, 32, 5], [60, 32, 5]] },
    { t: 62, d: [236], c: [[86, 22, 11]] },
    { t: 44, d: [196], c: [[46, 10, 3], [104, 32, 5]] },
  ] },
  { head: 72, rows: [
    { t: 292, d: [430, 104], c: [[28, 16, 8]] },
    { t: 142, d: [348], c: [[28, 16, 8]] },
    { t: 158, d: [436, 240], c: [[90, 32, 5]] },
  ] },
  { head: 104, sub: [300], rows: [
    { t: 150, d: [420, 96], c: [[124, 28, 5]] },
    { t: 88, d: [440, 76], c: [[140, 32, 5], [14, 10, 3], [140, 32, 5], [28, 16, 8]] },
  ] },
  { head: 160, sub: [440, 170], rows: [
    { t: 112, d: [420, 140], c: [[140, 32, 5], [14, 10, 3], [140, 32, 5]], c2: [[248, 24, 4]] },
    { t: 120, d: [400, 76], c: [[188, 28, 5]] },
  ] },
];
const INDEX_WIDTHS = [76, 50, 76, 112, 72, 98, 56, 40];

/** Loading: the first two sections at their own geometry and the section list's place, held still. */
function SettingsLoading() {
  return (
    <div className="set-page set-loading" aria-busy="true" aria-label="Loading settings">
      <div className="set-main">
        {LOADING.map((sec, s) => (
          <div key={s} className="set-sec">
            <div className="set-sk-head">
              <Skeleton h={13} w={sec.head} />
              {sec.link ? <Skeleton h={10} w={sec.link} /> : null}
            </div>
            {sec.sub ? <div className="set-sk-sub">{sec.sub.map((w, j) => <span key={j} className="set-sk-line"><Skeleton h={9} w={w} /></span>)}</div> : null}
            <div className="set-list">
              {sec.rows.map((row, i) => {
                const blocks = (bs: Block[]) => bs.map(([w, h, r], j) => <Skeleton key={j} h={h} w={w} r={r} />);
                return (
                  <div key={i} className="set-row">
                    <div className="set-words">
                      <span className="set-sk-line"><Skeleton h={11} w={row.t} /></span>
                      {row.d.map((w, j) => <span key={j} className="set-sk-line set-sk-desc"><Skeleton h={9} w={w} /></span>)}
                    </div>
                    <div className="set-control">
                      {row.c2 ? <div className="set-hours"><div className="set-times">{blocks(row.c)}</div><div className="set-times">{blocks(row.c2)}</div></div> : blocks(row.c)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="set-index" aria-hidden>
        {INDEX_WIDTHS.map((w, i) => <span key={i} className="set-sk-index"><Skeleton h={10} w={w} /></span>)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the page

export function SettingsScreen() {
  const status = useQuery(() => call("setup_status"), []);
  const settings = useQuery(() => call("settings"), []);
  const theme = useTheme();
  const scan = useSkillScan();
  useEffect(() => { rescanSkills(); }, []);
  const saves = useRowSaves();
  const { view: s, change } = useSettingsSaves(settings, saves);
  const page = useRef<HTMLDivElement>(null);

  const setBackground = async (enabled: boolean) => {
    const row = "Keep Omega Star running in the background";
    const before = status.data;
    if (before) status.set({ ...before, background: enabled });
    saves.saving(row);
    try {
      status.set(await call("set_background", { enabled }));
      saves.saved(row);
    } catch (e) {
      if (before) status.set(before);
      saves.failed(row, sentence(errorMessage(e)), () => void setBackground(enabled));
    }
  };
  const openData = async () => {
    saves.clear("Office folder");
    try { await call("open_data_dir"); }
    catch (e) { saves.failed("Office folder", sentence(errorMessage(e)), () => void openData()); }
  };

  const st = status.data;
  const err = (!settings.data && !settings.loading && settings.error) || (!st && !status.loading && status.error) || null;
  let body: ReactNode;
  if (err) {
    body = (
      <div className="set-state">
        <ErrorNote title="Couldn't load your settings" text={`${sentence(err)} Nothing was changed.`} onRetry={() => { settings.reload(); status.reload(); }} />
      </div>
    );
  } else if (!s || !st || !settings.data) {
    body = <SettingsLoading />;
  } else {
    const n = s.notifications;
    body = (
      <SaveRows.Provider value={saves.rows}>
        <div ref={page} className="set-page">
          <div className="set-main">
            <Group
              title="Claude Code"
              action={<button type="button" className="set-link" onClick={() => void openHelp()}>Claude Code docs<Icon name="external" size={12} /></button>}
            >
              <Row title="Installation" desc={<Swap on={`${st.claude.found}${st.claude.path}`}>{st.claude.found ? <span className="mono">{st.claude.path}</span> : "Not found. Install Claude Code or point to it below."}</Swap>}>
                {st.claude.found ? <span className="pill pill-ok"><Icon name="check" size={11} /> v{st.claude.version}</span> : <span className="pill pill-err">Not found</span>}
              </Row>
              <PathRow
                confirmed={settings.data.claudePath ?? ""}
                onEdit={() => saves.clear("Path override")}
                onSave={(path) => change("Path override", (x) => ({ ...x, claudePath: path || null }), () => status.reload())}
              />
              {s.proxy.url ? (
                <Row title="Account" desc="Runs use the CLI proxy's accounts, not the one Claude Code is signed in to.">
                  <span className="tag">CLI proxy</span>
                </Row>
              ) : (
                <Row title="Account" desc={st.account?.loggedIn ? <>{st.account.email} · {st.account.orgName}{st.account.plan ? ` · ${st.account.plan}` : null}</> : "Not signed in. Run this in a terminal, then come back."}>
                  {st.account?.loggedIn ? <span className="pill pill-ok"><Icon name="check" size={11} /> Signed in</span> : <CopyCommand command="claude auth login" />}
                </Row>
              )}
              <Row title="Skills" desc={<SkillsDesc scan={scan} />}>
                {scan.sources ? <span className={`set-count num ${scan.sources.found === 0 ? "set-count-warn" : ""}`}>{scan.sources.found === 1 ? "1 skill" : `${scan.sources.found} skills`}</span> : null}
                <button className="btn" onClick={rescanSkills} disabled={scan.scanning}>
                  <States at={scan.scanning ? 1 : 0} labels={[<><Icon name="refresh" size={13} />Rescan</>, "Scanning…"]} />
                </button>
              </Row>
            </Group>

            <Group title="Running">
              <Row title="Keep Omega Star running in the background" desc="Schedules only run while Omega Star is open. With this on, it starts at login and stays in the tray.">
                <Switch checked={st.background} onChange={(v) => void setBackground(v)} label="Run in the background" />
              </Row>
              <Row title="Pause all schedules" desc={<Swap on={String(s.paused)}>{s.paused ? "Nobody runs on a schedule until you resume. Manual runs and conversations still work." : "Stop every schedule at once, for a holiday or a noisy week."}</Swap>}>
                <Switch checked={s.paused} onChange={(v) => change("Pause all schedules", (x) => ({ ...x, paused: v }))} label="Pause schedules" />
              </Row>
              <Row title="Runs at the same time" desc="Across the office, and for any one employee. Extra work waits its turn. What you type to an employee is never held up; card answers and approvals wait like other work.">
                <Stepper
                  label="Runs at the same time" value={s.maxConcurrentRuns} min={1} max={16} less="Fewer runs at the same time" more="More runs at the same time"
                  onChange={(v) => change("Runs at the same time", (x) => ({ ...x, maxConcurrentRuns: v }))}
                />
              </Row>
            </Group>

            <NotificationsGroup n={n} change={change} />

            <RepliesGroup w={s.watch} change={change} />

            <Group title="Appearance">
              <Row title="Theme" desc="System follows your computer's light or dark setting.">
                <div className="seg" role="group" aria-label="Theme">
                  {(["system", "light", "dark"] as ThemePref[]).map((t) => (
                    <button key={t} aria-pressed={theme === t} onClick={() => setTheme(t)}>
                      <Icon name={t === "system" ? "monitor" : t === "light" ? "sun" : "moon"} size={14} /> {t[0].toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
              </Row>
            </Group>

            <BackupsGroup s={s} change={change} saves={saves} onOpenData={() => void openData()} />

            <ProxyGroup
              confirmed={settings.data.proxy}
              onEdit={() => saves.clear("CLI proxy")}
              onSave={(proxy, then) => change("CLI proxy", (x) => ({ ...x, proxy }), () => { status.reload(); then(); })}
            />

            <Group title="About">
              <Row title="Omega Star" desc={aboutDesc(st)}>
                <span className="set-version num">v{st.build.version}</span>
                <span className="tag">{CHANNELS[st.build.channel]}</span>
              </Row>
              <UpdateRow channel={st.build.channel} />
            </Group>
          </div>
          <SectionIndex host={page} />
          <p className="set-sr" aria-live="polite">{saves.said}</p>
        </div>
      </SaveRows.Provider>
    );
  }
  return <PageColumn title="Settings" className="set-col">{body}</PageColumn>;
}

function SkillsDesc({ scan }: { scan: SkillScan }) {
  const src = scan.sources;
  if (!src) return scan.error ? <span className="set-err">{sentence(scan.error)}</span> : <>Looking for your Claude Code skills…</>;
  const note = src.unreadable > 0 ? `${src.unreadable === 1 ? "1 skill" : `${src.unreadable} skills`} couldn't be read.` : null;
  return (
    <>
      <span className="mono">{src.skillsDir}</span>
      {note ? <span className="set-note">{note}</span> : null}
      {src.error && (src.found === 0 || src.unreadable > 0) ? <span className="set-note mono">{src.error}</span> : null}
    </>
  );
}

/** The Claude Code path: Save reports on the button; a failed save is the row's line with Try again, like every other
 *  row. `confirmed` is what the app last saved, so a failed save keeps what you typed. */
function PathRow({ confirmed, onEdit, onSave }: { confirmed: string; onEdit: () => void; onSave: (path: string) => void }) {
  const [draft, setDraft] = useState(confirmed);
  useEffect(() => { setDraft(confirmed); }, [confirmed]);
  const save = useRowSave("Path override");
  const failed = save?.state === "failed";
  const changed = draft.trim() !== confirmed;
  return (
    <Row title="Path override" desc="Leave empty to find Claude Code automatically." mark={false}>
      <form className="set-field-row" onSubmit={(e) => { e.preventDefault(); if (changed) onSave(draft.trim()); }}>
        <input
          className="input mono set-input" value={draft} placeholder="Automatic" aria-label="Claude Code path"
          onChange={(e) => { setDraft(e.target.value); if (failed) onEdit(); }}
        />
        <SaveButton state={failed ? undefined : save?.state} disabled={!changed} />
      </form>
    </Row>
  );
}

const CHANNELS: Record<BuildChannel, string> = { release: "Release", dogfood: "Test build", dev: "Developer build" };

/** Whether a newer version is out, and why not when the check failed, with a way to check now. */
function UpdateRow({ channel }: { channel: BuildChannel }) {
  const { checking, version, error, at } = useUpdateCheck();
  const [key, desc] =
    channel === "dev" ? ["dev", "Developer builds don't update themselves."]
    : checking ? ["checking", "Checking…"]
    : error ? [`error${error}`, <span className="set-err">{sentence(error)}</span>]
    : version ? [`v${version}`, `Omega Star ${version} is ready. Use Restart to update in the sidebar.`]
    : at ? [`at${at}`, `Up to date. Checked ${relTime(new Date(at).toISOString())}.`]
    : ["never", "Checks when Omega Star opens, then every hour."];
  return (
    <Row title="Updates" desc={<Swap on={key}>{desc}</Swap>}>
      <button className="btn" disabled={checking || channel === "dev"} onClick={checkForUpdate}>Check now</button>
    </Row>
  );
}

/** This build's commit, then the Claude Code version and organisation the same status found, when known. */
function aboutDesc(st: SetupStatus): string {
  const app = `Built from ${st.build.commit}.`;
  const version = st.claude.version;
  const org = st.account?.orgName ?? null;
  if (version && org) return `${app} Claude Code ${version}, signed in to ${org}.`;
  if (version) return `${app} Claude Code ${version}.`;
  if (org) return `${app} Signed in to ${org}.`;
  return app;
}

// ---------------------------------------------------------------- CLI proxy

type ProxyErrors = Partial<Record<"url" | "managementKey", string>>;

/** Sends every run through a CLI proxy (CLIProxyAPI) instead of the signed-in account. While it is off the section is
 *  one row and Set up; its fields open in place. `confirmed` is what the app last saved, so a failed save keeps what
 *  you typed. */
function ProxyGroup({ confirmed, onEdit, onSave }: {
  confirmed: ProxySettings; onEdit: () => void; onSave: (proxy: ProxySettings, then: () => void) => void;
}) {
  const confirmedKey = JSON.stringify(confirmed);
  const [draft, setDraft] = useState(confirmed);
  useEffect(() => { setDraft(JSON.parse(confirmedKey) as ProxySettings); }, [confirmedKey]);
  const [setup, setSetup] = useState(false);
  const [errs, setErrs] = useState<ProxyErrors>({});
  const save = useRowSave("CLI proxy");
  const address = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const ids = useId();
  const on = !!confirmed.url;
  const open = on || setup;
  const failed = save?.state === "failed";

  // Once the form has opened (or an error has opened under a field), scroll so its Save sits a section's gap above the
  // bottom of the page, without pushing its first row under the header.
  const reveal = useCallback(() => {
    const scroller = form.current?.closest<HTMLElement>(".pagecol-scroll");
    const foot = form.current?.querySelector<HTMLElement>(".set-foot");
    const first = form.current?.parentElement?.previousElementSibling;
    if (!scroller || !foot || !first) return;
    const view = scroller.getBoundingClientRect();
    const short = 48 - (view.bottom - foot.getBoundingClientRect().bottom);
    const room = first.getBoundingClientRect().top - view.top - 24;
    const by = Math.min(short, room);
    if (by > 0) scroller.scrollBy({ top: by, behavior: reducedMotion() ? "auto" : "smooth" });
  }, []);
  const afterOpening = useCallback(() => window.setTimeout(reveal, ms("--d-arrive") + 40), [reveal]);
  useEffect(() => {
    if (!setup) return;
    address.current?.focus({ preventScroll: true });
    const t = afterOpening();
    return () => window.clearTimeout(t);
  }, [setup, afterOpening]);
  useEffect(() => {
    if (!errs.url && !errs.managementKey && !failed) return;
    const t = afterOpening();
    return () => window.clearTimeout(t);
  }, [errs, failed, afterOpening]);

  const changed = (["url", "apiKey", "managementKey"] as const).some((k) => draft[k].trim() !== confirmed[k]);
  const edit = (key: keyof ProxySettings) => (e: { target: { value: string } }) => {
    setDraft({ ...draft, [key]: e.target.value });
    if (key in errs) setErrs({ ...errs, [key]: undefined });
    if (save?.state === "failed") onEdit();
  };
  const submit = () => {
    const next = { url: draft.url.trim().replace(/\/+$/, ""), apiKey: draft.apiKey.trim(), managementKey: draft.managementKey.trim() };
    const found: ProxyErrors = {};
    if (next.url && !/^https?:\/\//.test(next.url)) found.url = "The CLI proxy address must start with http:// or https://.";
    if (next.managementKey && next.managementKey === next.apiKey) found.managementKey = "The management key is the proxy's management secret, not one of its API keys.";
    setErrs(found);
    if (found.url) return address.current?.focus();
    if (found.managementKey) return;
    onSave(next, () => { if (!next.url) setSetup(false); });
  };
  const cancel = () => {
    setDraft(confirmed);
    setErrs({});
    setSetup(false);
    onEdit();
  };
  const field =(key: "url" | "apiKey" | "managementKey", label: string, extra: { placeholder?: string; type?: string } = {}) => {
    const err = key === "apiKey" ? undefined : errs[key];
    return (
      <div className="set-field">
        <input
          ref={key === "url" ? address : undefined} className="input mono set-input" value={draft[key]} onChange={edit(key)} aria-label={label}
          aria-invalid={err ? true : undefined} aria-describedby={err ? `${ids}${key}` : undefined} {...extra}
        />
        <FieldError id={`${ids}${key}`} text={err ?? null} />
      </div>
    );
  };
  return (
    <Group title="CLI proxy" sub="Send every run through a CLIProxyAPI server, so employees share its pool of Claude accounts.">
      <Row
        title="Status"
        desc={<Swap on={confirmed.url}>{on ? `Runs go through ${confirmed.url}. Claude in Chrome and claude.ai connectors still use Claude Code's own sign-in.` : "Off. Runs use the account Claude Code is signed in to."}</Swap>}
      >
        {open ? null : <button type="button" className="btn" onClick={() => setSetup(true)}>Set up</button>}
      </Row>
      <div className="collapse" data-open={open} inert={!open}>
        <form ref={form} onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          <Row title="Address" desc={on ? "Leave empty to turn the proxy off." : undefined} mark={false} fail={false}>
            {field("url", "CLI proxy address", { placeholder: "http://127.0.0.1:8317" })}
          </Row>
          <Row title="API key" desc="One of the keys in the proxy's config." mark={false} fail={false}>
            {field("apiKey", "CLI proxy API key", { type: "password" })}
          </Row>
          <Row title="Management key" desc={<>Optional, and not an API key: the <span className="mono">secret-key</span> under <span className="mono">management</span> in the proxy's config. Lets the sidebar show Claude usage averaged across the proxy's accounts.</>} mark={false} fail={false}>
            {field("managementKey", "CLI proxy management key", { type: "password" })}
          </Row>
          {/* A failed save opens the same line, with Try again, as on every other row. */}
          <div className="set-row set-foot">
            <div className="set-words">
              <FailLine id={`${ids}save`} save={save} />
            </div>
            <div className="set-control">
              {on ? null : <button type="button" className="btn btn-ghost" onClick={cancel}>Cancel</button>}
              <SaveButton state={failed ? undefined : save?.state} disabled={!changed} />
            </div>
          </div>
        </form>
      </div>
    </Group>
  );
}

// ---------------------------------------------------------------- data and backups

const FREQUENCIES: { value: BackupFrequency; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const TRANSCRIPT_DAYS: { value: number | null; label: string }[] = [
  { value: null, label: "Forever" },
  { value: 365, label: "1 year" },
  { value: 90, label: "90 days" },
  { value: 30, label: "30 days" },
];

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** "Today at 3:00 am", "Fri at 8:00 am"; `inline` lowers Today, Tomorrow and Yesterday for the middle of a sentence. */
function whenAt(iso: string, inline = false): string {
  const w = whenShort(iso).replace(/ (\d{1,2}:\d{2} [ap]m)$/, " at $1");
  return inline ? w.replace(/^(Today|Tomorrow|Yesterday)/, (m) => m.toLowerCase()) : w;
}

/** The last backup's lines. They stay as they are while a backup runs (the button says so), and change in place when
 *  it finishes, so the row never collapses and regrows. */
function LastBackup({ st, frequency, hideFailure }: { st: BackupStatus; frequency: BackupFrequency; hideFailure: boolean }) {
  const failed = !!st.lastError && !hideFailure; // cleared by the next success
  return (
    <>
      {st.lastAt ? <>{whenAt(st.lastAt)}{st.lastBytes != null ? `, ${size(st.lastBytes)}` : null}</> : "No backups yet."}
      {st.skipped > 0 ? <span className="set-note">{st.skipped === 1 ? "1 file" : `${st.skipped} files`} couldn't be read and {st.skipped === 1 ? "was" : "were"} left out.</span> : null}
      {st.leftOut > 0 ? <span className="set-note">{st.leftOut} large files and build folders were left out.</span> : null}
      {st.lastAt && st.checkedAt && Date.parse(st.checkedAt) > Date.parse(st.lastAt) ? <span className="set-note">Nothing has changed since. Checked {relTime(st.checkedAt)}.</span> : null}
      {failed ? <span className="set-note set-err">Last attempt {relTime(st.lastAttemptAt)} failed: {sentence(st.lastError ?? "")}</span> : null}
      {frequency !== "off" && st.nextAt ? <span className="set-note">Next backup {Date.parse(st.nextAt) <= Date.now() ? "within a minute" : whenAt(st.nextAt, true)}</span> : null}
    </>
  );
}

function BackupsGroup({ s, change, saves, onOpenData }: { s: AppSettings; change: Change; saves: Saves; onOpenData: () => void }) {
  const status = useQuery(() => call("backup_status"), [], ["backup:updated"]);
  // "asking": backup_now hasn't answered; "waiting": it answered while the backup still runs. The row's lines, its
  // button and its "Saved" change together once the status says it has finished.
  const [phase, setPhase] = useState<"idle" | "asking" | "waiting">("idle");
  const lastFailed = useRowSave("Last backup")?.state === "failed";
  const b = s.backup;
  const setBackup = (row: string, next: Partial<BackupSettings>) => change(row, (x) => ({ ...x, backup: { ...x.backup, ...next } }));

  const backUpNow = async () => {
    setPhase("asking");
    saves.clear("Last backup");
    try {
      status.set(await call("backup_now"));
      setPhase("waiting");
    } catch (e) {
      setPhase("idle");
      status.reload();
      saves.failed("Last backup", sentence(errorMessage(e)), () => void backUpNow());
    }
  };
  const again = useRef(() => {});
  useEffect(() => { again.current = () => void backUpNow(); });
  const st = status.data;
  useEffect(() => {
    if (phase !== "waiting" || !st || st.running) return;
    setPhase("idle");
    const failedNow = !!st.lastError && !!st.lastAttemptAt && (!st.lastAt || Date.parse(st.lastAttemptAt) > Date.parse(st.lastAt));
    if (failedNow) saves.failed("Last backup", sentence(st.lastError ?? ""), () => again.current());
    else saves.saved("Last backup");
  }, [phase, st, saves]);
  const choose = async () => {
    saves.clear("Backup folder");
    try {
      const dir = await call("pick_backup_dir");
      if (dir && dir !== b.dir) setBackup("Backup folder", { dir });
    } catch (e) { saves.failed("Backup folder", sentence(errorMessage(e))); }
  };
  const open = async () => {
    saves.clear("Backup folder");
    try { await call("open_backup_dir"); }
    catch (e) { saves.failed("Backup folder", sentence(errorMessage(e)), () => void open()); }
  };

  const running = phase !== "idle" || !!st?.running;
  const kept = TRANSCRIPT_DAYS.find((t) => t.value === s.transcriptDays);
  const lastKey = st ? `${st.lastAt}${st.checkedAt}${st.lastError}` : status.error ? "error" : "wait";
  return (
    <Group
      title="Data and backups"
      foot={<p className="set-aside"><span className="set-aside-title">Restoring</span> Quit Omega Star from the tray, replace everything in the office folder with the contents of a backup zip, then start Omega Star again.</p>}
    >
      <Row title="Office folder" desc={<span className="mono">{s.dataDir}</span>}>
        <button className="btn" onClick={onOpenData}><Icon name="folder" size={13} /> Open</button>
      </Row>
      <Row title="Keep transcripts" desc={<Swap on={String(s.transcriptDays)}>{s.transcriptDays == null ? "Every run's full transcript stays in the office folder." : `A run's full transcript is deleted ${kept ? kept.label : `${s.transcriptDays} days`} after it finishes. Its report and any pages it showed stay.`}</Swap>}>
        <div className="seg" role="group" aria-label="Keep transcripts">
          {TRANSCRIPT_DAYS.map((t) => (
            <button key={t.label} aria-pressed={s.transcriptDays === t.value} onClick={() => change("Keep transcripts", (x) => ({ ...x, transcriptDays: t.value }))}>{t.label}</button>
          ))}
        </div>
      </Row>
      <Row title="Automatic backups" desc={<Swap on={String(b.frequency === "off")}>{b.frequency === "off" ? "Only when you back up by hand." : "A copy of the office: employees, their history, skills and notes. Skipped when nothing has changed. Large files (over 10 MB) and build and cache folders such as node_modules are left out."}</Swap>}>
        <div className="seg" role="group" aria-label="Backup frequency">
          {FREQUENCIES.map((f) => (
            <button key={f.value} aria-pressed={b.frequency === f.value} onClick={() => setBackup("Automatic backups", { frequency: f.value })}>{f.label}</button>
          ))}
        </div>
      </Row>
      <Row title="Backup folder" desc={<Swap on={b.dir}><span className="mono">{b.dir}</span></Swap>}>
        <button className="btn" onClick={() => void choose()}>Choose…</button>
        <button className="btn" onClick={() => void open()}><Icon name="folder" size={13} /> Open</button>
      </Row>
      <Row title="Backups to keep" desc={<>Older backups in the folder are deleted automatically.{b.keep === 1 && b.frequency !== "off" ? <span className="set-note set-warn">One copy is a single restore point: a mistake you notice after the next backup can't be undone. Keep at least 3.</span> : null}</>}>
        <Stepper
          label="Backups to keep" value={b.keep} min={1} max={100} less="Fewer backups to keep" more="More backups to keep"
          onChange={(v) => setBackup("Backups to keep", { keep: v })}
        />
      </Row>
      <Row title="Last backup" desc={<Swap on={lastKey}>{st ? <LastBackup st={st} frequency={b.frequency} hideFailure={lastFailed} /> : status.error ? <span className="set-err">{sentence(status.error)}</span> : "Checking…"}</Swap>}>
        <button className="btn" onClick={() => void backUpNow()} disabled={running}>
          <States at={running ? 1 : 0} labels={[<><Icon name="archive" size={13} />Back up now</>, "Backing up…"]} />
        </button>
      </Row>
    </Group>
  );
}

// ---------------------------------------------------------------- notifications and replies

const CHECK_FREQUENCIES: { value: CheckFrequency; label: string }[] = [
  { value: "eager", label: "Often" },
  { value: "normal", label: "Normal" },
  { value: "relaxed", label: "Less often" },
];

const WEEKDAYS: { day: IsoWeekday; label: string; name: string }[] = [
  { day: 1, label: "Mon", name: "Monday" },
  { day: 2, label: "Tue", name: "Tuesday" },
  { day: 3, label: "Wed", name: "Wednesday" },
  { day: 4, label: "Thu", name: "Thursday" },
  { day: 5, label: "Fri", name: "Friday" },
  { day: 6, label: "Sat", name: "Saturday" },
  { day: 7, label: "Sun", name: "Sunday" },
];

const HALF_HOURS = Array.from({ length: 49 }, (_, i) => i * 30);
const NUDGE_DAYS = [0, 1, 2, 3, 4, 5];
const GIVE_UP_DAYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const minuteLabel = (minute: number) => clockHM(Math.floor(minute / 60) % 24, minute % 60);
const businessDays = (n: number) => `${n} business ${n === 1 ? "day" : "days"}`;
const withCurrent = (options: number[], current: number) => (options.includes(current) ? options : [...options, current].sort((a, b) => a - b));

const NOTIFY_MODES: { value: NotifyMode; label: string; desc: string }[] = [
  { value: "all", label: "All", desc: "Each one as it comes." },
  { value: "batched", label: "Batched", desc: "Decisions an employee sends within 90 seconds of the first arrive as one notification." },
  { value: "off", label: "Off", desc: "None. The Inbox and the dock badge still show what waits on you." },
];

/** Quiet hours when you first turn them on: overnight, 10 pm to 8 am. */
const QUIET_HOURS: QuietHours = { startMinute: 22 * 60, endMinute: 8 * 60 };

function NotificationsGroup({ n, change }: { n: NotificationSettings; change: Change }) {
  const q = n.quiet;
  const setN = (row: string, next: Partial<NotificationSettings>) => change(row, (x) => ({ ...x, notifications: { ...x.notifications, ...next } }));
  const mode = NOTIFY_MODES.find((m) => m.value === n.mode);
  const times = (current: number) => withCurrent(HALF_HOURS.slice(0, -1), current);
  // The times stay on screen while they fade out after quiet hours are turned off.
  const shown = usePresence(!!q, 140);
  const [kept, setKept] = useState<QuietHours>(q ?? QUIET_HOURS);
  if (q && (q.startMinute !== kept.startMinute || q.endMinute !== kept.endMinute)) setKept(q);
  const t = q ?? kept;
  return (
    <Group title="Notifications" sub="Desktop notifications when an employee needs you.">
      <Row title="Desktop notifications" desc={<Swap on={n.mode}>{mode?.desc}</Swap>}>
        <div className="seg" role="group" aria-label="Desktop notifications">
          {NOTIFY_MODES.map((m) => (
            <button key={m.value} aria-pressed={n.mode === m.value} onClick={() => setN("Desktop notifications", { mode: m.value })}>{m.label}</button>
          ))}
        </div>
      </Row>
      <Row title="Quiet hours" desc={<Swap on={q ? "on" : "off"}>{q ? `No notifications from ${minuteLabel(q.startMinute)} to ${minuteLabel(q.endMinute)}. When they end, one notification says what came in.` : "Notifications can come at any hour."}</Swap>}>
        {shown ? (
          <span className={`set-times ${q ? "enter-fade" : "leave-fade"}`}>
            <select className="select set-select" aria-label="Start of quiet hours" value={t.startMinute} disabled={!q} onChange={(e) => setN("Quiet hours", { quiet: { ...t, startMinute: Number(e.target.value) } })}>
              {times(t.startMinute).map((m) => <option key={m} value={m} disabled={m === t.endMinute}>{minuteLabel(m)}</option>)}
            </select>
            <span className="muted">to</span>
            <select className="select set-select" aria-label="End of quiet hours" value={t.endMinute} disabled={!q} onChange={(e) => setN("Quiet hours", { quiet: { ...t, endMinute: Number(e.target.value) } })}>
              {times(t.endMinute).map((m) => <option key={m} value={m} disabled={m === t.startMinute}>{minuteLabel(m)}</option>)}
            </select>
          </span>
        ) : null}
        <Switch checked={!!q} onChange={(v) => setN("Quiet hours", { quiet: v ? kept : null })} label="Quiet hours" />
      </Row>
    </Group>
  );
}

function RepliesGroup({ w, change }: { w: WatchSettings; change: Change }) {
  const h = w.hours;
  const nudging = w.nudgeAfterDays > 0;
  const setWatch = (row: string, next: Partial<WatchSettings>) => change(row, (x) => ({ ...x, watch: { ...x.watch, ...next } }));
  const setHours = (next: Partial<BusinessHours>) => change("Business hours", (x) => ({ ...x, watch: { ...x.watch, hours: { ...x.watch.hours, ...next } } }));
  const toggleDay = (day: IsoWeekday) =>
    setHours({ days: h.days.includes(day) ? h.days.filter((d) => d !== day) : [...h.days, day].sort((a, b) => a - b) });

  return (
    <Group title="Replies from people" sub="When an employee asks someone on your org chart, Omega Star watches for the reply and reminds them once.">
      <Row title="Business hours" desc="Reminders and give-ups count only these hours. Teams chats are still checked outside them, less often.">
        <div className="set-hours">
          <span className="set-times">
            <select className="select set-select" aria-label="Start of the working day" value={h.startMinute} onChange={(e) => setHours({ startMinute: Number(e.target.value) })}>
              {withCurrent(HALF_HOURS.slice(0, -1), h.startMinute).map((m) => <option key={m} value={m} disabled={m >= h.endMinute}>{minuteLabel(m)}</option>)}
            </select>
            <span className="muted">to</span>
            <select className="select set-select" aria-label="End of the working day" value={h.endMinute} onChange={(e) => setHours({ endMinute: Number(e.target.value) })}>
              {withCurrent(HALF_HOURS.slice(1), h.endMinute).map((m) => <option key={m} value={m} disabled={m <= h.startMinute}>{minuteLabel(m)}</option>)}
            </select>
          </span>
          <div className="set-days" role="group" aria-label="Working days">
            {WEEKDAYS.map((d) => {
              const on = h.days.includes(d.day);
              const last = on && h.days.length === 1;
              return (
                <button key={d.day} type="button" aria-pressed={on} aria-label={d.name} aria-disabled={last || undefined} onClick={() => { if (!last) toggleDay(d.day); }}>
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
      </Row>
      <Row title="Check for replies" desc="How often Omega Star looks. Checks start often and slow down as an ask gets older.">
        <div className="seg" role="group" aria-label="Check frequency">
          {CHECK_FREQUENCIES.map((f) => (
            <button key={f.value} aria-pressed={w.frequency === f.value} onClick={() => setWatch("Check for replies", { frequency: f.value })}>{f.label}</button>
          ))}
        </div>
      </Row>
      <Row title="Nudge after" desc={<Swap on={String(nudging)}>{nudging ? "With no reply, the employee sends one short reminder: at the due date, or after this long if there isn't one." : "Nobody gets a reminder."}</Swap>}>
        <select className="select set-select" aria-label="Nudge after" value={w.nudgeAfterDays} onChange={(e) => setWatch("Nudge after", { nudgeAfterDays: Number(e.target.value) })}>
          {withCurrent(NUDGE_DAYS, w.nudgeAfterDays).map((d) => <option key={d} value={d} disabled={d > 0 && d >= w.giveUpAfterDays}>{d === 0 ? "Never" : businessDays(d)}</option>)}
        </select>
      </Row>
      <Row title="Give up after" desc="Then the employee goes on without the answer, or asks someone else. Counted from the due date if that's later.">
        <select className="select set-select" aria-label="Give up after" value={w.giveUpAfterDays} onChange={(e) => setWatch("Give up after", { giveUpAfterDays: Number(e.target.value) })}>
          {withCurrent(GIVE_UP_DAYS, w.giveUpAfterDays).map((d) => <option key={d} value={d} disabled={nudging && d <= w.nudgeAfterDays}>{businessDays(d)}</option>)}
        </select>
      </Row>
    </Group>
  );
}
