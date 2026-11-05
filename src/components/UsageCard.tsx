import { useState } from "react";
import { call, errorMessage } from "../api/client";
import type { UsageWindow } from "../api/types";
import { clockHM, relTime, resetsLabel } from "../lib/format";
import { useNow, useQuery, useUsage } from "../lib/hooks";
import { toast } from "../lib/toasts";
import { Icon } from "./Icon";
import "./UsageCard.css";

const level = (w: UsageWindow | null) => (!w ? "" : w.percent >= 95 ? "usage-err" : w.percent >= 80 ? "usage-warn" : "");
const pct = (w: UsageWindow | null) => (w ? `${Math.round(w.percent)}%` : "–");

/** One window: label, meter, percent, each row itself the Refresh: under the pointer its label says so. The tooltip
 *  names the card and holds the reset time and when it was checked; the reset time is on screen once the window runs
 *  high. */
function Window({ label, w, now, known, checked, refreshing, refresh }: {
  label: string; w: UsageWindow | null; now: number; known: boolean; checked: string; refreshing: boolean; refresh: () => void;
}) {
  const resets = w ? resetsLabel(w, new Date(now)) : "";
  const lv = level(w);
  const tip = `Claude usage, ${label}: ${w ? `${pct(w)} used${resets ? ` · ${resets}` : ""}` : known ? "not reported" : "checking"} · ${checked}`;
  return (
    <button className={`usage-row ${lv}`} onClick={refresh} disabled={refreshing} data-tip={tip} aria-label={`${tip}. Refresh`}>
      <span className="usage-label">
        <span className="usage-name">{label}</span>
        <span className="usage-act" aria-hidden>{refreshing ? <Icon name="refresh" size={12} /> : "Refresh"}</span>
      </span>
      <span className="usage-bar"><span style={{ transform: `scaleX(${w ? Math.min(100, w.percent) / 100 : 0})` }} /></span>
      <span className="mono num">{pct(w)}</span>
      {lv && resets ? <span className="usage-sub">{resets}</span> : !w ? <span className="usage-sub">{known ? "Not reported" : "Checking…"}</span> : null}
    </button>
  );
}

/** API-key accounts have no usage limits, so the card counts today's runs instead. */
function RunsToday() {
  const runs = useQuery(() => call("runs", { employeeId: null, limit: 500 }), [], ["run:updated"]);
  const startToday = new Date().setHours(0, 0, 0, 0);
  const n = (runs.data ?? []).filter((r) => Date.parse(r.createdAt) >= startToday).length;
  return (
    <>
      <div className="usage" aria-label="Runs today" title="API-key accounts have no usage limits">
        <div className="usage-head"><span>Runs today</span><span className="mono num">{n}</span></div>
      </div>
      <div className="usage-mini" data-tip={`${n} ${n === 1 ? "run" : "runs"} today`} aria-hidden>
        <span className="usage-mini-cost mono num">{n}</span>
      </div>
    </>
  );
}

/** Routines wait for the account the office was set up with; the button makes the signed-in one the office's own. */
function AccountIssue({ message, signedInAs }: { message: string; signedInAs: string | null }) {
  const [busy, setBusy] = useState(false);
  const use = () => {
    setBusy(true);
    call("use_signed_in_account").catch((e) => toast(errorMessage(e), "err")).finally(() => setBusy(false));
  };
  return (
    <div className="usage-note usage-note-warn">
      <span>{message}</span>
      {signedInAs ? <button className="btn btn-sm" onClick={use} disabled={busy}>Use {signedInAs} for the office</button> : null}
    </div>
  );
}

/** Sidebar card: Claude's 5-hour and 7-day usage limits. */
export function UsageCard() {
  const { usage, refreshing, refresh } = useUsage();
  const now = useNow(60_000);

  if (usage && !usage.subscription) return <RunsToday />;

  const five = usage?.fiveHour ?? null;
  const week = usage?.sevenDay ?? null;
  const known = !!usage?.observedAt;
  const checked = usage?.observedAt ? `Checked ${relTime(usage.observedAt, now)}` : "Not checked yet";
  const held = usage?.heldUntil && Date.parse(usage.heldUntil) > now ? new Date(usage.heldUntil) : null;
  // A hold from the 7-day limit can end days away, so another day is named.
  const heldDay = held && held.toDateString() !== new Date(now).toDateString() ? `${held.toLocaleDateString(undefined, { weekday: "short" })} ` : "";
  return (
    <>
      <div className={`usage ${refreshing ? "usage-refreshing" : ""}`} aria-label="Claude usage limits">
        <Window label="5-hour" w={five} now={now} known={known} checked={checked} refreshing={refreshing} refresh={refresh} />
        <Window label="7-day" w={week} now={now} known={known} checked={checked} refreshing={refreshing} refresh={refresh} />
        {held ? <div className="usage-note usage-note-warn">Work starts again {heldDay}at {clockHM(held.getHours(), held.getMinutes())}, when the limit resets.</div> : null}
        {usage?.accountIssue ? <AccountIssue message={usage.accountIssue.message} signedInAs={usage.accountIssue.signedInAs} /> : null}
        {usage?.proxyIssue ? <div className="usage-note usage-note-warn">{usage.proxyIssue}</div> : null}
      </div>
      <button className="usage-mini" onClick={refresh} data-tip={`Claude usage: 5-hour ${pct(five)} · 7-day ${pct(week)}`} aria-label={`Claude usage: 5-hour ${pct(five)}, 7-day ${pct(week)}. Refresh`}>
        <span className={`usage-mini-bar ${level(five)}`}><span style={{ transform: `scaleX(${five ? Math.min(100, five.percent) / 100 : 0})` }} /></span>
        <span className={`usage-mini-bar ${level(week)}`}><span style={{ transform: `scaleX(${week ? Math.min(100, week.percent) / 100 : 0})` }} /></span>
      </button>
    </>
  );
}
