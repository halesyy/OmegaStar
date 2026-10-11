// The startup gate: open the office, then onboarding until you have a company, then the Shell.
import { useCallback, useEffect, useState } from "react";
import { call, errorMessage } from "./api/client";
import type { SetupStatus } from "./api/types";
import { LogoMark } from "./components/Icon";
import { Toasts } from "./components/ui";
import { Shell } from "./Shell";
import { Onboarding } from "./screens/Onboarding";
import { refreshOrg } from "./lib/hooks";
import "./App.css";

export default function App() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    call("setup_status").then(setStatus, (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  let body;
  if (error) {
    body = (
      <div className="boot">
        <LogoMark size={40} />
        <p className="boot-title">Omega Star couldn't open the office</p>
        <p className="muted">{error}</p>
        <button className="btn" onClick={load}>Try again</button>
      </div>
    );
  } else if (!status) {
    body = <div className="boot boot-loading"><LogoMark size={40} /></div>;
  } else if (!status.company) {
    body = <Onboarding initial={status} onDone={(s) => { setStatus(s); refreshOrg(); }} />;
  } else {
    body = <Shell />;
  }
  return (
    <>
      {body}
      <Toasts />
    </>
  );
}
