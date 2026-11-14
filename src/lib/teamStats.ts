import type { TeamStats } from "../api/types";

/** How far back the Team page looks. */
export type TeamRange = "7" | "30" | "all";
export const RANGES: { id: TeamRange; label: string }[] = [{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "all", label: "All time" }];

/** One local day on the Team page's charts. */
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
const endOfDay = (key: string) => new Date(`${key}T23:59:59.999`).getTime();

/** The Team page's numbers for a range, from the Office's per-day rows. Days with nothing done still appear. */
export function summarise(stats: TeamStats, range: TeamRange, now = new Date()): TeamSummary {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const firstHire = stats.staff.reduce<number | null>((m, s) => { const t = Date.parse(s.hiredAt); return m === null || t < m ? t : m; }, null);
  const span = range === "all"
    ? Math.max(1, Math.round((today.getTime() - new Date(new Date(firstHire ?? today.getTime()).toDateString()).getTime()) / 86_400_000) + 1)
    : Number(range);
  const keys: string[] = [];
  for (let i = span - 1; i >= 0; i--) keys.push(dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
  const start = new Date(`${keys[0]}T00:00:00`).getTime();

  const byDay = new Map<string, TeamDayTotal>(keys.map((day) => {
    const end = endOfDay(day);
    const staff = stats.staff.filter((s) => Date.parse(s.hiredAt) <= end && (!s.departedAt || Date.parse(s.departedAt) > end)).length;
    return [day, { day, staff, runs: 0, workMs: 0, cards: 0, learned: 0 }];
  }));
  const perEmployee = new Map<string, number>();
  for (const r of stats.days) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.runs += r.runs; d.workMs += r.workMs; d.cards += r.cards;
    perEmployee.set(r.employeeId, (perEmployee.get(r.employeeId) ?? 0) + r.runs);
  }
  for (const l of stats.learned) { const d = byDay.get(l.day); if (d) d.learned += l.n; }

  const days = keys.map((k) => byDay.get(k)!);
  const sum = (f: (d: TeamDayTotal) => number) => days.reduce((n, d) => n + f(d), 0);
  const runs = sum((d) => d.runs), cards = sum((d) => d.cards);
  const names = new Map(stats.staff.map((s) => [s.employeeId, s.name]));
  const who = [...perEmployee].map(([employeeId, n]) => ({ employeeId, name: names.get(employeeId) ?? "Someone who left", runs: n })).sort((a, b) => b.runs - a.runs);
  const per = days.length > 31 ? "week" : "day";
  const points: TeamDayTotal[] = [];
  if (per === "day") points.push(...days);
  else for (let i = days.length % 7 ? -(7 - (days.length % 7)) : 0; i < days.length; i += 7) {
    const wk = days.slice(Math.max(0, i), i + 7);
    points.push({ day: wk[0].day, staff: wk[wk.length - 1].staff, runs: wk.reduce((n, d) => n + d.runs, 0), workMs: wk.reduce((n, d) => n + d.workMs, 0), cards: wk.reduce((n, d) => n + d.cards, 0), learned: wk.reduce((n, d) => n + d.learned, 0) });
  }
  return {
    days, points, per,
    staff: days[days.length - 1].staff,
    hired: stats.staff.filter((s) => Date.parse(s.hiredAt) >= start).length,
    left: stats.staff.filter((s) => s.departedAt && Date.parse(s.departedAt) >= start).length,
    runs, workMs: sum((d) => d.workMs), cards, learned: sum((d) => d.learned),
    perCard: cards ? runs / cards : null,
    who,
  };
}
