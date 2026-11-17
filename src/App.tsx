// The startup gate: open the office, then onboarding until you have a company, then the Shell.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { call, errorMessage } from "./api/client";
import type { SetupStatus } from "./api/types";
import { Icon } from "./components/Icon";
import { TipLayer, Toasts } from "./components/ui";
import { dragRegion, macChrome } from "./lib/chrome";
import { railNow } from "./lib/sidebar";
import { SideBrand, Shell } from "./Shell";
import { Onboarding } from "./screens/Onboarding";
import { refreshOrg } from "./lib/hooks";
import "./App.css";

export default function App() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when onboarding hands over, so the office's canvas arrives as one body swap rather than appearing.
  const [handedOver, setHandedOver] = useState(false);

  const load = useCallback(() => {
    setError(null);
    call("setup_status").then(setStatus, (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  let body;
  if (error) {
    body = (
      <Boot>
        <div className="boot-error" role="alert">
          <h1 className="boot-title">OmegaStar couldn't open the office</h1>
          <p className="boot-text">{error}</p>
          <button className="btn" onClick={load}><Icon name="refresh" size={13} /> Try again</button>
        </div>
      </Boot>
    );
  } else if (!status) {
    body = <Boot />;
  } else if (!status.company) {
    body = <Onboarding initial={status} onDone={(s) => { setHandedOver(true); setStatus(s); refreshOrg(); }} />;
  } else {
    body = <Shell arriving={handedOver} />;
  }
  return (
    <>
      {body}
      <Toasts />
      <TipLayer />
    </>
  );
}

/** The startup screen is the shell's own silhouette: the sidebar band with the brand where it will be, at the width it
 *  was left at, and still blocks where the search, the pages and the page's title will be. When the office opens, the
 *  real ones take their places and nothing jumps. */
function Boot({ children }: { children?: ReactNode }) {
  const rail = railNow();
  return (
    <div className={`boot ${rail ? "boot-rail" : ""}`} aria-busy={!children}>
      <div className="boot-side">
        {macChrome ? <div className="side-chrome" {...dragRegion} /> : null}
        <div className="side-top"><SideBrand /></div>
        {children ? null : <div className="boot-nav" aria-hidden><i className="boot-search" /><i /><i /><i /></div>}
      </div>
      <main className="boot-main">{children ?? <i className="boot-title-skel" aria-hidden />}</main>
    </div>
  );
}
