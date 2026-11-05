import { useEffect, useState } from "react";
import { call, errorMessage } from "../api/client";
import { useOrg } from "../lib/hooks";
import { checkForUpdate, useUpdateCheck } from "../lib/update";
import { Icon } from "./Icon";
import "./UpdateCard.css";

type Install = { kind: "installing" } | { kind: "failed"; message: string };

const HOUR = 3_600_000;
/** How long the rail's update button waits for its second click while work is running. */
const ARMED_MS = 4000;

/** The sidebar's offer of a newer version, once a check finds one: one quiet row with Restart. While work is running,
 *  Restart asks once first (on the rail, the first click arms it and its tooltip says why). This is what checks: now,
 *  then hourly. */
export function UpdateCard() {
  const { version } = useUpdateCheck();
  const [update, setUpdate] = useState<Install | null>(null);
  const [asking, setAsking] = useState(false);
  const [armed, setArmed] = useState(false);
  const { snap } = useOrg();

  useEffect(() => {
    checkForUpdate();
    const timer = setInterval(checkForUpdate, HOUR);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), ARMED_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  if (!version) return null;
  const installing = update?.kind === "installing";
  const failed = update?.kind === "failed" ? update.message : null;
  const working = (snap?.employees ?? []).some((e) => e.working > 0 || e.presence === "working");
  const install = () => {
    setAsking(false);
    setArmed(false);
    setUpdate({ kind: "installing" });
    call("install_update").catch((e) => setUpdate({ kind: "failed", message: errorMessage(e) }));
  };
  const label = installing ? "Updating…" : failed ? "Try again" : "Restart";
  const tip = installing ? "Updating…" : armed ? "Restarting stops work in progress. Click again to restart" : `Update ready: version ${version}`;

  return (
    <>
      <div className={`update ${asking ? "update-asking" : ""}`} aria-label="Update ready">
        <div className="update-row">
          <div className="update-text">
            <div className="update-title">Update ready</div>
            {failed ? null : <div className="update-sub">Version {version}</div>}
          </div>
          <button className="btn btn-sm update-btn" onClick={working && !installing ? () => setAsking(true) : install} disabled={installing || asking} aria-expanded={working ? asking : undefined}>
            {/* Every label in one slot, so the button holds the width of the longest and never shoves the row. */}
            <span className="update-btn-slot"><span aria-hidden>Updating…</span><span aria-hidden>Try again</span><span>{label}</span></span>
          </button>
        </div>
        {failed ? <div className="update-err" role="alert">{failed}</div> : null}
        <div className="collapse" data-open={asking}>
          <div>
            <div className="update-confirm" data-esc-stop onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setAsking(false); } }}>
              <p>Restarting stops work in progress.</p>
              <div className="update-confirm-acts">
                <button className="btn btn-sm btn-ghost" onClick={() => setAsking(false)} tabIndex={asking ? 0 : -1}>Keep</button>
                <button className="btn btn-sm update-btn" onClick={install} tabIndex={asking ? 0 : -1}>Restart</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <button
        className={`update-mini ${armed ? "update-mini-armed" : ""}`} disabled={installing} data-tip={tip}
        onClick={working && !installing && !armed ? () => setArmed(true) : install}
        aria-label={armed ? "Restarting stops work in progress. Press again to restart and update" : `Update Omega Star to ${version}`}
      >
        <Icon name="refresh" size={15} />
      </button>
    </>
  );
}
