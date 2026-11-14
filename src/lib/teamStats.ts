import type { TeamStats } from "../api/types";

/** How far back the Analytics page looks. */
export type TeamRange = "7" | "30" | "all";
export const RANGES: { id: TeamRange; label: string }[] = [{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "all", label: "All time" }];

/** One local day on the Analytics page's charts. */
export type TeamDayTotal = { day: string; staff: number; runs: number; workMs: number; cards: number; learned: number };
export type TeamSummary = {
  days: TeamDayTotal[];
  /** What the charts draw: the days, or whole weeks once the range runs past a month, so long lines stay readable.
   *  A week's staff is its last day's; its other numbers are sums. `day` is the week's first day. */
  points: TeamDayTotal[];
  per: "day" | "week";
  staff: number; hired: number; left: number;
  runs: number; workMs: number; cards: number; learned: number;
  /** Jobs done for each card raised for you: higher means the team gets on without you. Null with no cards. */
  perCard: number | null;
  who: { employeeId: string; name: string; runs: number }[];
};

const pad = (n: number) => String(n).padStart(2, "0");
/** A local date as `YYYY-MM-DD`, as the Office groups days. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const total = (ds: TeamDayTotal[], k: "runs" | "workMs" | "cards" | "learned") => ds.reduce((n, d) => n + d[k], 0);

/** The Analytics page's numbers for a range, from the Office's per-day rows. Days with nothing done still appear. */
export function summarise(stats: TeamStats, range: TeamRange, now = new Date()): TeamSummary {
  const day = (back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
  // Never before the first hire: days before the team existed would read as idle and drag the averages down.
  const first = new Date(Math.min(now.getTime(), ...stats.staff.map((s) => Date.parse(s.hiredAt))));
  const lived = Math.round((day(0).getTime() - new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime()) / 86_400_000) + 1;
  const span = range === "all" ? lived : Math.min(Number(range), lived);
  const start = day(span - 1).getTime();

  // Oldest day first. A day's staff is who was here as it ended.
  const byDay = new Map<string, TeamDayTotal>();
  for (let i = span - 1; i >= 0; i--) {
    const key = dayKey(day(i)), end = day(i - 1).getTime();
    const staff = stats.staff.filter((s) => Date.parse(s.hiredAt) < end && (!s.departedAt || Date.parse(s.departedAt) >= end)).length;
    byDay.set(key, { day: key, staff, runs: 0, workMs: 0, cards: 0, learned: 0 });
  }
  const perEmployee = new Map<string, number>();
  for (const r of stats.days) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.runs += r.runs; d.workMs += r.workMs; d.cards += r.cards;
    perEmployee.set(r.employeeId, (perEmployee.get(r.employeeId) ?? 0) + r.runs);
  }
  for (const l of stats.learned) { const d = byDay.get(l.day); if (d) d.learned += l.n; }

  const days = [...byDay.values()];
  const runs = total(days, "runs"), cards = total(days, "cards");
  const names = new Map(stats.staff.map((s) => [s.employeeId, s.name]));
  const who = [...perEmployee].map(([employeeId, n]) => ({ employeeId, name: names.get(employeeId) ?? "Someone who left", runs: n })).sort((a, b) => b.runs - a.runs);
  const per = days.length > 31 ? "week" : "day";
  // Weeks count back from today, so only the oldest can be short.
  const points: TeamDayTotal[] = per === "day" ? days : [];
  if (per === "week") for (let i = days.length; i > 0; i -= 7) {
    const wk = days.slice(Math.max(0, i - 7), i);
    points.unshift({ day: wk[0].day, staff: wk[wk.length - 1].staff, runs: total(wk, "runs"), workMs: total(wk, "workMs"), cards: total(wk, "cards"), learned: total(wk, "learned") });
  }
  return {
    days, points, per,
    staff: days[days.length - 1].staff,
    hired: stats.staff.filter((s) => Date.parse(s.hiredAt) >= start).length,
    left: stats.staff.filter((s) => s.departedAt && Date.parse(s.departedAt) >= start).length,
    runs, workMs: total(days, "workMs"), cards, learned: total(days, "learned"),
    perCard: cards ? runs / cards : null,
    who,
  };
}
