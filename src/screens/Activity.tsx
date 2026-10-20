import { useMemo, useState, type ReactNode } from "react";
import { call } from "../api/client";
import type { EmployeeView, PersonView, Run, SkillRevision } from "../api/types";
import { dayHeading, firstName, relTime } from "../lib/format";
import { useNow, useOrg, useQuery } from "../lib/hooks";
import { navigate, openMember, type ActivityView } from "../lib/router";
import { threadFocus } from "../lib/threads";
import { RunRow } from "../components/RunRow";
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
 *  the runs, what is going on: who they are waiting on, what they asked each other, and the week's numbers. */
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

function Runs({ who, name, employees }: { who: string | null; name: string | null; employees: EmployeeView[] }) {
  const { snap } = useOrg();
  const people = snap?.people ?? [];
  const q = useQuery(() => call("runs", { employeeId: null, limit: 300 }), [], ["run:updated"]);
  const runs = useMemo(() => (q.data ?? []).filter((r) => who === null || r.employeeId === who), [q.data, who]);
  const groups = useMemo(() => groupByDay(runs), [runs]);

  let list: ReactNode;
  if (q.error) list = <ErrorNote text={q.error} onRetry={q.reload} />;
  else if (!q.data) list = <div className="stack" style={{ gap: 10 }}>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} h={44} r={10} />)}</div>;
  else if (runs.length === 0) {
    list = (
      <div className="empty">
        <Icon name="activity" size={22} />
        <span className="empty-title">{name ? `No runs for ${name} yet` : "No runs yet"}</span>
        <p>Runs show up here the moment they start: schedules, Run now, and work employees hand each other.</p>
      </div>
    );
  } else {
    list = (
      <div className="activity-list">
        {groups.map((g) => (
          <div key={g.day} className="daygroup">
            <div className="daygroup-title">{g.day}</div>
            {g.runs.map((r) => <RunRow key={r.id} run={r} employee={employees.find((e) => e.id === r.employeeId)} employees={employees} people={people} showEmployee />)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <>
      <Waiting who={who} employees={employees} people={people} />
      <BetweenColleagues who={who} employees={employees} />
      <Scoreboard runs={runs} employees={employees} />
      {list}
    </>
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
function Scoreboard({ runs, employees }: { runs: Run[]; employees: EmployeeView[] }) {
  const now = useNow(60_000);
  const latest = new Map<string, Run>();
  for (const r of runs) {
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
