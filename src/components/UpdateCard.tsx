import { useEffect, useState } from "react";
import { call, errorMessage } from "../api/client";
import { useOrg } from "../lib/hooks";
import { checkForUpdate, useUpdateCheck } from "../lib/update";
import { Icon } from "./Icon";
import "./UpdateCard.css";

type Install = { kind: "installing" } | { kind: "failed"; message: string };

const HOUR = 3_600_000;

/** The sidebar's offer of a newer version, once a check finds one. This is what checks: now, then hourly. */
export function UpdateCard() {
  const { version } = useUpdateCheck();
  const [update, setUpdate] = useState<Install | null>(null);
  const { snap } = useOrg();

  useEffect(() => {
    checkForUpdate();
    const timer = setInterval(checkForUpdate, HOUR);
    return () => clearInterval(timer);
  }, []);

  if (!version) return null;
  const installing = update?.kind === "installing";
  const working = (snap?.employees ?? []).some((e) => e.working > 0 || e.presence === "working");
  const install = () => {
    setUpdate({ kind: "installing" });
    call("install_update").catch((e) => setUpdate({ kind: "failed", message: errorMessage(e) }));
  };

  return (
    <>
      <div className="update" aria-label="Update available">
        <div className="update-title">Update available</div>
        <div className="update-sub">Omega Star {version}</div>
        {working ? <div className="update-sub">Restarting stops work in progress.</div> : null}
        {update?.kind === "failed" ? <div className="update-err">{update.message}</div> : null}
        <button className="btn btn-primary btn-sm update-btn" onClick={install} disabled={installing}>
          {installing ? "Updating…" : update?.kind === "failed" ? "Try again" : "Restart to update"}
        </button>
      </div>
      <button className="update-mini" onClick={install} disabled={installing} data-tip={installing ? "Updating…" : `Update to ${version}`} aria-label={`Update Omega Star to ${version}`}>
        <Icon name="refresh" size={15} />
      </button>
    </>
  );
}
