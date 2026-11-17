import type { TeamStats } from "../api/types";

/** How far back the Analytics page looks. */
export type TeamRange = "7" | "30" | "all";
export const RANGES: { id: TeamRange; label: string }[] = [{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "all", label: "All time" }];

/** One column of the chart: a day, or a week once the range runs past a month. `day` is its first day. */
export type TeamPoint = { day: string; workMs: number; asks: number };

/** Someone on the team now: the hours they worked in the range and the number they answer for, if they have one yet. */
export type TeamPerson = { employeeId: string; name: string; workMs: number; number: TeamStats["numbers"][number] | null };

/** The Analytics page's numbers for one range: what the screen's two sentences, chart and table say. */
export type TeamSummary = {
  /** Who works here now. */
  team: number;
  /** When the first person was hired: where All time begins. */
  since: Date;
  runs: number; workMs: number; nightMs: number;
  /** Time worked over the equal span just before. Null for All time, and when the team did not exist for all of it. */
  workBefore: number | null;
  /** Cards that asked you something in the range. */
  asks: number;
  /** Half the asks got an answer within this. Null when fewer than half have one: an open ask counts as not yet, and one
   *  a newer card replaced or the employee withdrew is left out, since nobody waited on you for it. */
  medianWaitMs: number | null;
  /** Asks answered after more than a day, and asks still open more than a day after they came. */
  overDay: number;
  points: TeamPoint[];
  per: "day" | "week";
  /** Everyone here now, most hours first. */
  people: TeamPerson[];
};

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
/** A local date as `YYYY-MM-DD`, as the Office groups days. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The Analytics page's numbers for a range, from the Office's all-time rows. Days with nothing done still appear. */
export function summarise(stats: TeamStats, range: TeamRange, now = new Date()): TeamSummary {
  const day = (back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
  const since = new Date(Math.min(now.getTime(), ...stats.staff.map((s) => Date.parse(s.hiredAt))));
  // Never before the first hire: days before the team existed would read as idle.
  const lived = Math.round((day(0).getTime() - new Date(since.getFullYear(), since.getMonth(), since.getDate()).getTime()) / DAY) + 1;
  const span = range === "all" ? lived : Math.min(Number(range), lived);
  const days = (from: number, n: number) => Array.from({ length: n }, (_, i) => dayKey(day(from + n - 1 - i)));
  const before = range !== "all" && lived >= 2 * Number(range) ? new Set(days(Number(range), Number(range))) : null;

  const byDay = new Map(days(0, span).map((d): [string, TeamPoint] => [d, { day: d, workMs: 0, asks: 0 }]));
  const worked = new Map<string, number>();
  let runs = 0, workMs = 0, nightMs = 0, workBefore = 0;
  for (const r of stats.days) {
    const p = byDay.get(r.day);
    if (p) {
      p.workMs += r.workMs; runs += r.runs; workMs += r.workMs; nightMs += r.nightMs;
      worked.set(r.employeeId, (worked.get(r.employeeId) ?? 0) + r.workMs);
    } else if (before?.has(r.day)) workBefore += r.workMs;
  }

  let asks = 0, overDay = 0;
  const waits: number[] = [];
  for (const a of stats.asks) {
    const p = byDay.get(dayKey(new Date(a.at)));
    if (!p) continue;
    p.asks++; asks++;
    const at = Date.parse(a.at);
    // A card's time is its run's end, so one answered while its run still worked would read as answered early.
    if (a.answeredAt) { const w = Math.max(0, Date.parse(a.answeredAt) - at); waits.push(w); if (w > DAY) overDay++; }
    else if (a.open) { waits.push(Infinity); if (now.getTime() - at > DAY) overDay++; }
  }
  const median = waits.sort((x, y) => x - y)[Math.ceil(waits.length / 2) - 1];

  const all = [...byDay.values()];
  const per = all.length > 31 ? "week" : "day";
  // Weeks count back from today, so only the oldest can be short.
  const points: TeamPoint[] = per === "day" ? all : [];
  if (per === "week") for (let i = all.length; i > 0; i -= 7) {
    const wk = all.slice(Math.max(0, i - 7), i);
    points.unshift({ day: wk[0].day, workMs: wk.reduce((n, d) => n + d.workMs, 0), asks: wk.reduce((n, d) => n + d.asks, 0) });
  }

  const here = stats.staff.filter((s) => !s.departedAt);
  const people = here
    .map((s) => ({ employeeId: s.employeeId, name: s.name, workMs: worked.get(s.employeeId) ?? 0, number: stats.numbers.find((n) => n.employeeId === s.employeeId) ?? null }))
    .sort((a, b) => b.workMs - a.workMs);
  return {
    team: here.length, since, runs, workMs, nightMs,
    workBefore: before ? workBefore : null,
    asks, medianWaitMs: median !== undefined && Number.isFinite(median) ? median : null, overDay,
    points, per, people,
  };
}
