import { useMemo, useState, type ReactNode } from "react";
import { call } from "../api/client";
import type { EmployeeView, PersonView, Run, SkillRevision } from "../api/types";
import { dayHeading, duration, elapsedMs, firstName, MOD, relTime } from "../lib/format";
import { useNow, useOrg, useQuery } from "../lib/hooks";
import { navigate, openMember, openWork, type ActivityView } from "../lib/router";
import { blocked, threadFocus } from "../lib/threads";
import { RunRow, workLabel } from "../components/RunRow";
import { RequestCard } from "../components/RequestCard";
import { AskRow } from "../components/ColleagueAsks";
import { groupByDay } from "../components/panel/WorkTab";
import { lines } from "../components/conversation/RowHistory";
import { lineStats } from "../components/Diff";
import { Icon } from "../components/Icon";
import { Avatar, ErrorNote, PageColumn, Section, Skeleton } from "../components/ui";
import "./Activity.css";

/** How far back the week's numbers look: a week, with a day's slack for a review that ran late. */
const WEEK_MS = 8 * 24 * 3600 * 1000;

/** Everything that happened: the runs your employees did, or the changes they (and you) made to their skills. Above
 *  the runs, what is going on: what they are working on now, who they are waiting on, what they asked each other, and
 *  the week's numbers. */
export function ActivityScreen({ view }: { view: ActivityView }) {
  const { snap } = useOrg();
  const [who, setWho] = useState<string | null>(null);
  const employees = snap?.employees ?? [];
  const chosen = employees.find((e) => e.id === who);

  return (
    <PageColumn
      title="Activity"
      actions={
        <>
          <select className="select activity-who" value={who ?? ""} onChange={(ev) => setWho(ev.target.value || null)} aria-label="Whose activity">
            <option value="">Everyone</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <div className="seg" role="group" aria-label="Show">
            <button aria-pressed={view === "runs"} onClick={() => navigate({ page: "activity", view: "runs" })}>Runs</button>
            <button aria-pressed={view === "skills"} onClick={() => navigate({ page: "activity", view: "skills" })}>Skill changes</button>
          </div>
        </>
      }
    >
      {view === "runs" ? <Runs who={who} name={chosen ? firstName(chosen.name) : null} employees={employees} /> : <SkillChanges who={who} name={chosen ? firstName(chosen.name) : null} employees={employees} />}
    </PageColumn>
  );
}

type Filter = "all" | "needsYou" | "failed" | "conversations" | "handoffs" | "routines";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needsYou", label: "Needs you" },
  { id: "failed", label: "Failed" },
  { id: "conversations", label: "Conversations" },
  { id: "handoffs", label: "Hand-offs" },
  { id: "routines", label: "Routines" },
];

/** A turn of a conversation with you. Mirrors Rust `RunKind::is_conversation`. */
const conversation = (r: Run): boolean =>
  r.kind.type === "task" || r.kind.type === "reply" || r.kind.type === "chat" || (r.kind.type === "answered" && (r.kind.chat || !!r.kind.thread));

function shows(r: Run, f: Filter): boolean {
  switch (f) {
    case "all": return true;
    case "needsYou": return r.needsYou.length > 0 || blocked(r);
    case "failed": return r.state === "failed" || r.state === "lost";
    case "conversations": return conversation(r);
    case "handoffs": return r.kind.type === "delegated" || r.kind.type === "asked" || (r.kind.type === "answered" && !conversation(r));
    case "routines": return r.kind.type === "scheduled";
  }
}

/** A line of the run list: one run, or a routine's quiet runs of one day that did nothing. */
type Line = { run: Run } | { quiet: Run[] };

/** A day's runs as lines, newest first. A routine's quiet runs that succeeded and raised, handed on and changed nothing
 *  fold into one line where the newest of them is, once there are two. `handedOn`: runs that handed work to a colleague. */
function fold(runs: Run[], handedOn: Set<string>): Line[] {
  const idle = (r: Run) => r.kind.type === "scheduled" && r.kind.quiet && r.state === "succeeded"
    && !r.needsYou.length && !r.denials.length && !r.skillChanges.length && !handedOn.has(r.id);
  const routine = (r: Run) => (r.kind.type === "scheduled" && idle(r) ? r.kind.scheduleId : null);
  const idles = new Map<string, Run[]>();
  for (const r of runs) {
    const id = routine(r);
    if (id) idles.set(id, [...(idles.get(id) ?? []), r]);
  }
  const out: Line[] = [];
  for (const r of runs) {
    const id = routine(r);
    const same = id ? idles.get(id) ?? [] : [];
    if (same.length < 2) out.push({ run: r });
    else if (same[0] === r) out.push({ quiet: same });
  }
  return out;
}

function Runs({ who, name, employees }: { who: string | null; name: string | null; employees: EmployeeView[] }) {
  const { snap } = useOrg();
  const people = snap?.people ?? [];
  const [filter, setFilter] = useState<Filter>("all");
  const q = useQuery(() => call("runs", { employeeId: null, limit: 300 }), [], ["run:updated"]);
  const runs = useMemo(() => (q.data ?? []).filter((r) => (who === null || r.employeeId === who) && shows(r, filter)), [q.data, who, filter]);
  const groups = useMemo(() => groupByDay(runs), [runs]);
  const handedOn = useMemo(() => new Set((q.data ?? []).flatMap((r) => (r.kind.type === "delegated" || r.kind.type === "asked" ? [r.kind.parentRunId] : []))), [q.data]);

  let list: ReactNode;
  if (q.error) list = <ErrorNote text={q.error} onRetry={q.reload} />;
  else if (!q.data) list = <div className="stack" style={{ gap: 10 }}>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} h={44} r={10} />)}</div>;
  else if (runs.length === 0 && filter !== "all") {
    list = (
      <div className="empty">
        <Icon name="activity" size={22} />
        <span className="empty-title">Nothing here in the latest runs</span>
        <p>To find older work, search with {MOD} K.</p>
      </div>
    );
  } else if (runs.length === 0) {
    list = (
      <div className="empty">
        <Icon name="activity" size={22} />
        <span className="empty-title">{name ? `No runs for ${name} yet` : "No runs yet"}</span>
        <p>Runs show up here the moment they start: schedules, Run now, and work employees hand each other.</p>
      </div>
    );
  } else {
    const employee = (r: Run) => employees.find((e) => e.id === r.employeeId);
    list = (
      <div className="activity-list">
        {groups.map((g) => (
          <div key={g.day} className="daygroup">
            <div className="daygroup-title">{g.day}</div>
            {fold(g.runs, handedOn).map((l) => "quiet" in l
              ? <QuietRuns key={l.quiet[0].id} runs={l.quiet} employee={employee(l.quiet[0])} employees={employees} people={people} />
              : <RunRow key={l.run.id} run={l.run} employee={employee(l.run)} employees={employees} people={people} showEmployee />)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <>
      <Today who={who} employees={employees} />
      <WorkingNow who={who} employees={employees} people={people} />
      <Waiting who={who} employees={employees} people={people} />
      <BetweenColleagues who={who} employees={employees} />
      <Scoreboard who={who} employees={employees} />
      <WeekUsage who={who} employees={employees} />
      <div className="activity-runs">
        <div className="activity-filters" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        {list}
      </div>
    </>
  );
}

/** A routine's quiet runs of one day that did nothing, as one line that opens to list them. */
function QuietRuns({ runs, employee, employees, people }: { runs: Run[]; employee?: EmployeeView; employees: EmployeeView[]; people: PersonView[] }) {
  const [open, setOpen] = useState(false);
  const newest = runs[0];
  return (
    <>
      <button className="runrow" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {employee ? <Avatar name={employee.name} hue={employee.hue} size={28} /> : <span className="runrow-icon"><Icon name="clock" size={14} /></span>}
        <span className="runrow-main">
          <span className="runrow-title">
            {employee ? <b>{firstName(employee.name)}</b> : null}
            <span className="muted">{workLabel(newest, employees, people)}</span>
          </span>
          <span className="runrow-detail">{runs.length} quiet runs, nothing to report</span>
        </span>
        <span className="runrow-meta">
          <span className="runrow-when">
            <span className="faint">{relTime(newest.startedAt ?? newest.createdAt)}</span>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
          </span>
        </span>
      </button>
      {open ? runs.map((r) => <RunRow key={r.id} run={r} employee={employee} employees={employees} people={people} showEmployee />) : null}
    </>
  );
}

/** Local midnight `daysBack` days ago, as the backend takes a time; it changes only when the day does. */
function useDayStart(daysBack = 0): string {
  const d = new Date(useNow(60_000));
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.toISOString();
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Usage in US dollars at API list price: "$12.40", "<$0.01", or "$0" when no run recorded what it cost. */
const usd = (n: number) => (n <= 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/** Each employee's day so far: their runs, the decisions they raised, the work they handed on, failures and usage. */
function Today({ who, employees }: { who: string | null; employees: EmployeeView[] }) {
  const since = useDayStart();
  const q = useQuery(() => call("run_usage", { since }), [since], ["run:updated"]);
  const rows = employees.filter((e) => who === null || e.id === who).flatMap((e) => {
    const u = q.data?.employees.find((x) => x.employeeId === e.id);
    return u ? [{ e, u }] : [];
  });
  if (!rows.length) return null;
  return (
    <Section title="Today" count={null}>
      <div className="digest">
        {rows.map(({ e, u }) => (
          <button key={e.id} className="digest-row" onClick={() => openMember(e.id, "work")}>
            <Avatar name={e.name} hue={e.hue} size={20} />
            <b className="digest-who">{firstName(e.name)}</b>
            <span className="digest-what">
              {[count(u.runs, "run"), u.decisions ? count(u.decisions, "decision") : null, u.handoffs ? count(u.handoffs, "hand-off") : null].filter(Boolean).join(" · ")}
              {u.failed ? <span className="digest-failed"> · {u.failed} failed</span> : null}
            </span>
            <span className="digest-usage num" title="Usage (API list price)">{usd(u.costUsd)}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

/** This week's usage per employee, most first, and per routine with what its runs did: something (raised a card,
 *  handed work on, changed a skill or failed) or nothing. */
function WeekUsage({ who, employees }: { who: string | null; employees: EmployeeView[] }) {
  const since = useDayStart(6);
  const q = useQuery(() => call("run_usage", { since }), [since], ["run:updated"]);
  const rows = (q.data?.employees ?? [])
    .filter((u) => who === null || u.employeeId === who)
    .flatMap((u) => {
      const e = employees.find((m) => m.id === u.employeeId);
      const routines = (q.data?.routines ?? []).filter((r) => r.employeeId === u.employeeId).sort((a, b) => b.costUsd - a.costUsd);
      return e ? [{ e, u, routines }] : [];
    })
    .sort((a, b) => b.u.costUsd - a.u.costUsd);
  if (!rows.length) return null;
  return (
    <Section title="This week's usage (API list price)" count={null}>
      <div className="usage">
        {rows.map(({ e, u, routines }) => (
          <div key={e.id} className="usage-group">
            <button className="usage-row" onClick={() => openMember(e.id, "work")}>
              <Avatar name={e.name} hue={e.hue} size={20} />
              <b className="usage-who">{firstName(e.name)}</b>
              <span className="usage-what">{count(u.runs, "run")}</span>
              <span className="usage-cost num">{usd(u.costUsd)}</span>
            </button>
            {routines.map((r) => (
              <button key={r.scheduleId} className="usage-row usage-routine" onClick={() => openMember(e.id, "work")}>
                <span />
                <span className="usage-name">{r.label}</span>
                <span className="usage-what" title="A run did something when it raised a card, handed work to a colleague, changed a skill or failed.">
                  {count(r.runs, "run")}: {r.useful} did something, {r.runs - r.useful} nothing
                </span>
                <span className="usage-cost num">{usd(r.costUsd)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
}

/** Every run going on right now, running first and oldest first, each opening where it can be followed. */
function WorkingNow({ who, employees, people }: { who: string | null; employees: EmployeeView[]; people: PersonView[] }) {
  const live = employees
    .filter((e) => who === null || e.id === who)
    .flatMap((e) => e.live.map((run) => ({ run, e })))
    .sort((a, b) => Number(b.run.state === "running") - Number(a.run.state === "running") || a.run.createdAt.localeCompare(b.run.createdAt));
  const now = useNow(1000, live.some((x) => x.run.state === "running"));
  if (!live.length) return null;
  return (
    <Section title="Working now" count={live.length}>
      <div className="now">
        {live.map(({ run, e }) => (
          <button key={run.id} className="now-row" onClick={() => openWork(run)}>
            <Avatar name={e.name} hue={e.hue} size={20} presence={run.state === "running" ? "working" : undefined} />
            <b className="now-who">{firstName(e.name)}</b>
            <span className="now-what">{workLabel(run, employees, people)}</span>
            <span className="now-state mono num">{run.state === "running" ? duration(elapsedMs(run, now)) : "Waiting to start"}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

/** Requests your employees made of people that are still open, each answered or chased in place. */
function Waiting({ who, employees, people }: { who: string | null; employees: EmployeeView[]; people: PersonView[] }) {
  const q = useQuery(() => call("requests", { personId: null, employeeId: who, state: "open" }), [who], ["request:updated", "org:changed"]);
  if (!q.data?.length) return null;
  return (
    <Section title="Waiting on people" count={q.data.length} id="waiting">
      <div className="plist">
        {q.data.map((r) => (
          <RequestCard key={r.id} r={r} employee={employees.find((e) => e.id === r.employeeId)} person={people.find((p) => p.id === r.personId)} showPerson onChanged={() => q.reload()} />
        ))}
      </div>
    </Section>
  );
}

/** Asks between employees that have not come back yet. */
function BetweenColleagues({ who, employees }: { who: string | null; employees: EmployeeView[] }) {
  const q = useQuery(() => call("open_asks"), [], ["run:updated"]);
  const asks = (q.data ?? []).filter((r) => who === null || r.employeeId === who || (r.kind.type === "asked" && r.kind.askedBy === who));
  if (!asks.length) return null;
  return (
    <Section title="Between colleagues" count={asks.length}>
      <div className="plist">
        {asks.map((r) => <AskRow key={r.id} run={r} employees={employees} />)}
      </div>
    </Section>
  );
}

/** The week in numbers: each employee's latest weekly review from the last week, as the number it reported, else its
 *  first line. Each opens the review on the employee's panel. */
function Scoreboard({ who, employees }: { who: string | null; employees: EmployeeView[] }) {
  const now = useNow(60_000);
  const q = useQuery(() => call("week_reviews"), [], ["run:updated"]);
  const latest = new Map<string, Run>();
  for (const r of q.data ?? []) {
    if (who !== null && r.employeeId !== who) continue;
    if (r.kind.type !== "scheduled" || !r.kind.review || r.state !== "succeeded" || now - Date.parse(r.createdAt) > WEEK_MS) continue;
    const had = latest.get(r.employeeId);
    if (!had || had.createdAt < r.createdAt) latest.set(r.employeeId, r);
  }
  const rows = [...latest.values()].flatMap((r) => {
    const e = employees.find((m) => m.id === r.employeeId);
    return e ? [{ r, e }] : [];
  });
  if (!rows.length) return null;
  return (
    <Section title="This week's numbers" count={null}>
      <div className="score">
        {rows.map(({ r, e }) => {
          const s = r.score;
          return (
            <button key={r.id} className="score-row" onClick={() => openMember(e.id, "chat", threadFocus(r.id))}>
              <Avatar name={e.name} hue={e.hue} size={20} />
              <b className="score-who">{firstName(e.name)}</b>
              {s ? (
                <>
                  <span className="score-metric">{s.metric}</span>
                  <span className="score-value num">{s.value}</span>
                  <span className="score-change faint">{s.change}</span>
                </>
              ) : (
                <span className="score-metric score-plain">{lines(r.summary)[0] ?? "Reviewed the week"}</span>
              )}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

type Change = { r: SkillRevision; e: EmployeeView };

/** Every employee's skill history, newest first, reloaded when the office changes. */
function useChanges(employees: EmployeeView[]): Change[] | undefined {
  const load = () => Promise.all(employees.map(async (e) => (await call("skill_history", { employeeId: e.id }).catch(() => [])).map((r) => ({ r, e }))))
    .then((all) => all.flat().sort((a, b) => b.r.at.localeCompare(a.r.at)));
  return useQuery(load, [employees.map((e) => e.id)], ["org:changed"]).data;
}

function SkillChanges({ who, name, employees }: { who: string | null; name: string | null; employees: EmployeeView[] }) {
  const all = useChanges(employees);
  const changes = useMemo(() => (all ?? []).filter((c) => who === null || c.e.id === who), [all, who]);
  const groups = useMemo(() => {
    const out: { day: string; items: Change[] }[] = [];
    for (const c of changes) {
      const day = dayHeading(c.r.at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(c);
      else out.push({ day, items: [c] });
    }
    return out;
  }, [changes]);

  if (!all) return <div className="stack" style={{ gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={40} r={10} />)}</div>;
  if (changes.length === 0) {
    return (
      <div className="empty">
        <Icon name="layers" size={22} />
        <span className="empty-title">{name ? `${name} hasn't changed a skill yet` : "No skill changes yet"}</span>
        <p>When you teach an employee something, or they learn from a run, the change to their skill shows up here. Any change can be undone.</p>
      </div>
    );
  }
  return (
    <div className="activity-list">
      {groups.map((g) => (
        <div key={g.day} className="daygroup">
          <div className="daygroup-title">{g.day}</div>
          {g.items.map(({ r, e }) => <ChangeRow key={r.id} r={r} e={e} />)}
        </div>
      ))}
    </div>
  );
}

function ChangeRow({ r, e }: { r: SkillRevision; e: EmployeeView }) {
  const s = lineStats(r.before, r.after);
  const verb = r.change === "added" ? "created" : r.change === "removed" ? "removed" : "changed";
  const how = r.runId ? "while working" : r.change === "added" ? "at setup" : "edited by you";
  return (
    <button className="runrow" onClick={() => openMember(e.id, "skills", `rev~${r.id}`)}>
      <Avatar name={e.name} hue={e.hue} size={28} />
      <span className="runrow-main">
        <span className="runrow-title"><b>{firstName(e.name)}</b> <span className="muted">{verb}</span> <span className="mono change-skill">{r.skill}{r.file !== "SKILL.md" ? `/${r.file}` : ""}</span></span>
        <span className="runrow-detail">{how}</span>
      </span>
      <span className="runrow-meta">
        <span className="runrow-when">
          <span className="mono num change-lines">{s.added ? <span className="tl-add">+{s.added}</span> : null}{s.removed ? <span className="tl-del">−{s.removed}</span> : null}</span>
          <span className="faint">{relTime(r.at)}</span>
        </span>
      </span>
    </button>
  );
}
