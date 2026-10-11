// Plain-words descriptions and presets for 5-field cron schedules (the Office runs them with croner).
import { clockHM } from "./format";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Plain words for the common patterns (the presets and a few more); null for anything else. */
export function describeCron(expr: string): string | null {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return null;
  const [mi, h, dom, mon, dow] = p;
  const simpleTime = /^\d+$/.test(mi) && /^\d+$/.test(h);
  const time = simpleTime ? clockHM(Number(h), Number(mi)) : "";
  if (dom === "*" && mon === "*") {
    if (h === "*" && /^\d+$/.test(mi)) return mi === "0" ? "Every hour" : `Every hour at :${pad(Number(mi))}`;
    if (/^\*\/\d+$/.test(mi) && h === "*") return `Every ${mi.slice(2)} minutes`;
    if (simpleTime) {
      if (dow === "*") return `Every day at ${time}`;
      if (dow === "1-5") return `Every weekday at ${time}`;
      if (dow === "0,6" || dow === "6,0") return `Weekends at ${time}`;
      if (/^[0-7]$/.test(dow)) return `Every ${DAY_NAMES[Number(dow) % 7]} at ${time}`;
      if (/^[0-7](,[0-7])+$/.test(dow)) return `${dow.split(",").map((d) => DAY_NAMES[Number(d) % 7].slice(0, 3)).join(", ")} at ${time}`;
    }
  }
  if (simpleTime && /^\d+$/.test(dom) && mon === "*" && dow === "*") return `Monthly on day ${dom} at ${time}`;
  return null;
}

export type CronPresetId = "weekdays" | "weekly" | "daily" | "hourly" | "custom";
export const CRON_PRESETS: { id: CronPresetId; label: string }[] = [
  { id: "weekdays", label: "Every weekday" },
  { id: "weekly", label: "Every Monday" },
  { id: "daily", label: "Daily" },
  { id: "hourly", label: "Hourly" },
  { id: "custom", label: "Custom" },
];

export function presetCron(id: Exclude<CronPresetId, "custom">, time: string): string {
  const [h, m] = time.split(":").map((x) => Number(x) || 0);
  switch (id) {
    case "weekdays": return `${m} ${h} * * 1-5`;
    case "weekly": return `${m} ${h} * * 1`;
    case "daily": return `${m} ${h} * * *`;
    case "hourly": return `0 * * * *`;
  }
}

/** Recognise a cron string as one of the presets, for editing an existing schedule. */
export function matchPreset(cron: string): { id: CronPresetId; time: string } {
  const p = cron.trim().split(/\s+/);
  if (p.length === 5 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1]) && p[2] === "*" && p[3] === "*") {
    const time = `${pad(Number(p[1]))}:${pad(Number(p[0]))}`;
    if (p[4] === "1-5") return { id: "weekdays", time };
    if (p[4] === "1") return { id: "weekly", time };
    if (p[4] === "*") return { id: "daily", time };
  }
  if (cron.trim() === "0 * * * *") return { id: "hourly", time: "09:00" };
  return { id: "custom", time: "09:00" };
}
