import { useState, type ReactNode } from "react";
import { call, errorMessage } from "../api/client";
import type { SetupStatus } from "../api/types";
import { CopyCommand } from "../components/CopyCommand";
import { Icon, LogoMark } from "../components/Icon";
import { ErrorNote, Switch } from "../components/ui";
import "./Onboarding.css";

/** `check` steps are verified by Omega Star and earn a green check; `input` and `pref` steps keep their number. */
function Step({ n, done, title, kind = "check", children }: { n: number; done: boolean; title: string; kind?: "check" | "input" | "pref"; children: ReactNode }) {
  const verified = done && kind === "check";
  return (
    <li className={`ob-step ${verified ? "ob-step-done" : ""} ${done && kind === "input" ? "ob-step-filled" : ""}`}>
      <span className="ob-mark" aria-hidden>{verified ? <Icon name="check" size={12} strokeWidth={2} /> : n}</span>
      <div className="stack grow" style={{ minWidth: 0, gap: 6 }}>
        <span className="ob-title">{title}</span>
        {children}
      </div>
    </li>
  );
}

export function Onboarding({ initial, onDone }: { initial: SetupStatus; onDone: (s: SetupStatus) => void }) {
  const [status, setStatus] = useState(initial);
  const [company, setCompany] = useState("");
  const [ceo, setCeo] = useState("");
  const [title, setTitle] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const found = status.claude.found;
  const loggedIn = status.account?.loggedIn ?? false;
  const named = company.trim().length > 0 && ceo.trim().length > 0;
  const ready = found && loggedIn && named;

  const recheck = async () => {
    setChecking(true);
    try { setStatus(await call("setup_status")); } catch (e) { setErr(errorMessage(e)); } finally { setChecking(false); }
  };
  const setBackground = async (enabled: boolean) => {
    setStatus((s) => ({ ...s, background: enabled }));
    try { setStatus(await call("set_background", { enabled })); } catch (e) { setErr(errorMessage(e)); }
  };
  const finish = async () => {
    setBusy(true);
    setErr(null);
    try {
      const c = await call("complete_setup", { companyName: company.trim(), ceoName: ceo.trim(), title: title.trim() || null });
      onDone({ ...status, company: c });
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="ob">
      <div className="ob-card">
        <div className="ob-head">
          <LogoMark size={44} />
          <h1 className="h-xl">Connect to Claude Code</h1>
          <p className="muted">Omega Star turns the Claude Code on this computer into a company you run. Four quick steps and you're in charge.</p>
        </div>
        <ol className="ob-steps">
          <Step n={1} done={found} title={found ? "Claude Code found" : "Claude Code not found"}>
            {found ? (
              <span className="ob-detail"><span className="mono">{status.claude.path}</span><span className="pill">v{status.claude.version}</span></span>
            ) : (
              <>
                <span className="ob-detail">Install it, then check again.</span>
                <div className="row"><CopyCommand command="npm install -g @anthropic-ai/claude-code" /><button className="btn btn-sm" disabled={checking} onClick={() => void recheck()}>Check again</button></div>
              </>
            )}
          </Step>
          <Step n={2} done={loggedIn} title={loggedIn ? "Signed in" : "Sign in to Claude Code"}>
            {loggedIn && status.account ? (
              <span className="ob-detail">{status.account.email}<span className="faint">·</span>{status.account.orgName}{status.account.plan ? <span className="pill pill-accent">{status.account.plan}</span> : null}</span>
            ) : (
              <>
                <span className="ob-detail">Run this in a terminal and follow the browser prompt.</span>
                <div className="row"><CopyCommand command="claude auth login" /><button className="btn btn-sm" disabled={checking} onClick={() => void recheck()}>{checking ? "Checking…" : "Check again"}</button></div>
              </>
            )}
          </Step>
          <Step n={3} done={named} kind="input" title="Name your company">
            <label className="field ob-names">
              <span className="field-label">Company</span>
              <input className="input" autoFocus value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Kestrel Labs" />
            </label>
            <div className="form-2">
              <label className="field">
                <span className="field-label">Your name</span>
                <input className="input" value={ceo} onChange={(e) => setCeo(e.target.value)} placeholder="Your name"
                  onKeyDown={(e) => { if (e.key === "Enter" && ready) void finish(); }} />
              </label>
              <label className="field">
                <span className="field-label">Your title <span className="hint">optional</span></span>
                <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="CEO"
                  onKeyDown={(e) => { if (e.key === "Enter" && ready) void finish(); }} />
              </label>
            </div>
          </Step>
          <Step n={4} done={status.background} kind="pref" title="Keep Omega Star running in the background">
            <div className="ob-bg">
              <span className="ob-detail">Schedules only fire while Omega Star runs, so it will start at login and wait quietly in the tray.</span>
              <Switch checked={status.background} onChange={(v) => void setBackground(v)} label="Keep running in the background" />
            </div>
          </Step>
        </ol>
        {err ? <ErrorNote text={err} /> : null}
        <button className="btn btn-primary btn-lg ob-go" disabled={!ready || busy} onClick={() => void finish()}>
          {busy ? "Opening…" : "Open your office"} <Icon name="arrowRight" size={15} />
        </button>
      </div>
    </div>
  );
}
