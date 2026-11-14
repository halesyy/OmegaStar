import { useMemo } from "react";
import { call } from "../api/client";
import { useQuery } from "../lib/hooks";
import { RANGES, summarise, type TeamDayTotal, type TeamRange } from "../lib/teamStats";
import { navigate } from "../lib/router";
import { Icon } from "../components/Icon";
import { ErrorNote, PageColumn, Skeleton } from "../components/ui";
import "./Team.css";

const short = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const hours = (ms: number) => { const h = ms / 3_600_000; return h >= 10 ? Math.round(h).toString() : h.toFixed(1); };
const one = (n: number) => (Number.isInteger(n) || n >= 10 ? Math.round(n).toString() : n.toFixed(1));

/**
 * The Team page, opened from the staff chip on the org chart: how big the team is, how it has grown and how much it
 * gets done, over the last week, month or all time. One page, one concern: it only shows, it changes nothing.
 */
export function TeamScreen({ range }: { range: TeamRange }) {
  const q = useQuery(() => call("team_stats"), [], ["org:changed"]);
  const setRange = (r: TeamRange) => navigate({ page: "team", range: r }, { replace: true });
  const s = useMemo(() => (q.data ? summarise(q.data, range) : null), [q.data, range]);

  return (
    <PageColumn title="Team" className="team">
      <div className="team-top">
        <button className="btn btn-ghost btn-sm team-back" onClick={() => navigate({ page: "org", memberId: null, tab: null, focus: null })}>
          <Icon name="chevronRight" size={14} className="team-back-icon" />Org chart
        </button>
        <div className="seg" role="group" aria-label="How far back">
          {RANGES.map((r) => <button key={r.id} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>)}
        </div>
      </div>
      {q.error ? <ErrorNote title="Couldn't count the team" text={q.error} onRetry={q.reload} /> : null}
      {!s && !q.error ? <Skeleton h={220} r={8} /> : null}
      {s ? (
        <>
          <div className="team-kpis">
            <Kpi label="Staff" value={String(s.staff)} note={s.hired || s.left ? [s.hired ? `+${s.hired} hired` : "", s.left ? `${s.left} left` : ""].filter(Boolean).join(", ") : "No change"} good={s.hired > 0} />
            <Kpi label="Jobs done" value={String(s.runs)} note={`${one(s.runs / s.days.length)} a day`} />
            <Kpi label="Hours worked" value={hours(s.workMs)} note="Time spent working" />
            <Kpi label="Jobs per card to you" value={s.perCard === null ? "–" : one(s.perCard)} note="Higher: they need you less" />
          </div>
          <div className="team-charts">
            <Chart title="Staff" hint={`Headcount each ${s.per}`} days={s.points} value={(d) => d.staff} kind="step" />
            <Chart title="Jobs done" hint={`Work finished each ${s.per}`} days={s.points} value={(d) => d.runs} kind="bars" />
            <Chart title="Learning" hint={`Skill updates each ${s.per}`} days={s.points} value={(d) => d.learned} kind="line" tone="ok" />
            <Chart title="Needing you less" hint="Jobs done per card they raised" days={s.points} value={(d) => (d.cards ? d.runs / d.cards : null)} kind="line" tone="ink" />
          </div>
          <section className="team-who">
            <h2 className="team-h">Who did the work</h2>
            <p className="team-hint">Jobs done in this time</p>
            {s.who.length === 0 ? <p className="team-hint">Nothing finished yet.</p> : null}
            {s.who.slice(0, 8).map((w) => (
              <div className="team-row" key={w.employeeId}>
                <span className="team-name">{w.name}</span>
                <span className="team-bar"><span style={{ width: `${(w.runs / s.who[0].runs) * 100}%` }} /></span>
                <span className="team-n num">{w.runs}</span>
              </div>
            ))}
            {s.who.length > 8 ? (
              <div className="team-row team-more">
                <span className="team-name">{s.who.length - 8} more</span><span />
                <span className="team-n num">{s.who.slice(8).reduce((n, w) => n + w.runs, 0)}</span>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </PageColumn>
  );
}

function Kpi({ label, value, note, good }: { label: string; value: string; note: string; good?: boolean }) {
  return (
    <div className="team-kpi">
      <span className="team-kpi-label">{label}</span>
      <span className="team-kpi-value num">{value}</span>
      <span className={`team-kpi-note ${good ? "team-good" : ""}`}>{note}</span>
    </div>
  );
}

const W = 320, H = 120, PAD = { l: 8, r: 8, t: 18, b: 20 };

/** A small chart of one number per day: bars, a line, or a step line for headcount. Drawn in SVG, scaled to fit. */
function Chart({ title, hint, days, value, kind, tone = "live" }: {
  title: string; hint: string; days: TeamDayTotal[]; value: (d: TeamDayTotal) => number | null;
  kind: "bars" | "line" | "step"; tone?: "live" | "ok" | "ink";
}) {
  const vals = days.map(value);
  const nums = vals.filter((v): v is number => v !== null);
  const max = Math.max(1, ...nums);
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const step = iw / days.length;
  const x = (i: number) => PAD.l + step * i + step / 2;
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const last = [...vals].reverse().find((v) => v !== null) ?? null;
  const pts = vals.map((v, i) => (v === null ? null : [x(i), y(v)] as const)).filter((p): p is readonly [number, number] => p !== null);
  let path = "";
  if (kind === "step") path = pts.map(([px, py], i) => (i === 0 ? `M${PAD.l} ${py} H${px}` : `V${py} H${px}`)).join(" ") + (pts.length ? ` H${W - PAD.r}` : "");
  if (kind === "line") path = pts.map(([px, py], i) => `${i ? "L" : "M"}${px} ${py}`).join(" ");
  return (
    <div className="team-chart">
      <div className="team-chart-head">
        <span><h2 className="team-h">{title}</h2><p className="team-hint">{hint}</p></span>
        <span className="team-chart-now num">{last === null ? "–" : one(last)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className={`team-svg team-${tone}`} role="img" aria-label={`${title}: ${hint}`}>
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih} y2={PAD.t + ih} className="team-axis" />
        {kind === "bars" ? vals.map((v, i) => v ? (
          <rect key={i} x={x(i) - Math.min(18, step * 0.7) / 2} width={Math.min(18, step * 0.7)} y={y(v)} height={PAD.t + ih - y(v)} rx={2} className="team-fill">
            <title>{`${short(days[i].day)}: ${v}`}</title>
          </rect>
        ) : null) : null}
        {kind === "step" && pts.length ? <path d={`${path} V${PAD.t + ih} H${PAD.l} Z`} className="team-area" /> : null}
        {kind !== "bars" ? <path d={path} className="team-stroke" /> : null}
        {kind === "line" ? pts.map(([px, py], i) => <circle key={i} cx={px} cy={py} r={days.length > 14 ? 1.6 : 2.6} className="team-dot" />) : null}
        <text x={PAD.l} y={H - 5} className="team-tick">{short(days[0].day)}</text>
        <text x={W - PAD.r} y={H - 5} className="team-tick" textAnchor="end">{days.length > 1 ? short(days[days.length - 1].day) : ""}</text>
        <text x={PAD.l} y={11} className="team-tick">{`Most ${one(max)}`}</text>
      </svg>
    </div>
  );
}
