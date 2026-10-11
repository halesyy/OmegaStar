import { useState } from "react";
import { call, errorMessage } from "../api/client";
import type { EmployeeView, Run } from "../api/types";
import { firstName } from "../lib/format";
import { refreshOrg } from "../lib/hooks";
import { toast } from "../lib/toasts";
import { mcpServerName, mcpServerRule, toolName } from "../lib/rules";
import { Icon } from "./Icon";
import { ErrorNote } from "./ui";
import "./BlockedCard.css";

type Scope = "tool" | "server";

/** Whether the employee can already do this without asking: the rule itself, a server wildcard, or the browser switch. */
function covers(e: EmployeeView, rule: string): boolean {
  if (e.browser && rule.startsWith("mcp__claude-in-chrome__")) return true;
  return e.allowRules.some((r) => r === rule || (r.endsWith("__*") && rule.startsWith(r.slice(0, -1))));
}

/** What a run was blocked on, and the way forward: allow it once or for good, and the employee retries. */
export function BlockedCard({ run, employee }: { run: Run; employee: EmployeeView | undefined }) {
  const who = employee ? firstName(employee.name) : "They";
  const [scope, setScope] = useState<Record<number, Scope>>({});
  const [busy, setBusy] = useState<"once" | "always" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const rows = run.denials.map((d, i) => {
    const server = mcpServerRule(d.tool);
    const sc: Scope = server ? scope[i] ?? "tool" : "tool";
    const rule = sc === "server" && server ? server : d.suggestedRule;
    return { d, i, server, sc, rule, already: !!employee && covers(employee, rule) };
  });
  const rules = [...new Set(rows.map((r) => r.rule))];
  const many = rows.length > 1;

  const approve = async (always: boolean) => {
    setBusy(always ? "always" : "once");
    setErr(null);
    try {
      await call("approve_blocked", { runId: run.id, rules, always });
      if (always) refreshOrg();
      toast(always ? `${who} is retrying, and can do this from now on` : `${who} is retrying, with your OK for this run only`, "ok");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="blocked" aria-label="Blocked actions">
      <div className="blocked-head"><Icon name="shield" size={14} /> {many ? `${rows.length} actions were blocked` : "One action was blocked"}</div>
      <p className="blocked-lead">Allow {many ? "them" : "it"} and {who} picks the work back up where it stopped.</p>
      {rows.map((r) => {
        const server = mcpServerName(r.d.tool);
        return (
          <div key={r.i} className="blocked-row">
            <div className="blocked-what">
              <span className="blocked-tool">
                <b className="mono">{toolName(r.d.tool)}</b>
                {server ? <span className="pill">{server}</span> : null}
                {r.already ? <span className="pill pill-ok">Already allowed</span> : null}
              </span>
              <span className="blocked-brief mono">{r.d.brief}</span>
            </div>
            {r.server ? (
              <div className="seg blocked-scope" role="group" aria-label={`What to allow for ${toolName(r.d.tool)}`}>
                <button type="button" aria-pressed={r.sc === "tool"} onClick={() => setScope((s) => ({ ...s, [r.i]: "tool" }))}>Just this tool</button>
                <button type="button" aria-pressed={r.sc === "server"} onClick={() => setScope((s) => ({ ...s, [r.i]: "server" }))}>All {server} tools</button>
              </div>
            ) : (
              <span className="blocked-rule faint mono">{r.rule}</span>
            )}
          </div>
        );
      })}
      {err ? <ErrorNote text={err} /> : null}
      <div className="blocked-actions">
        <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void approve(false)}>
          <Icon name="check" size={13} /> Allow once &amp; retry
        </button>
        <button className="btn btn-sm" disabled={busy !== null} onClick={() => void approve(true)} title={`Saves ${rules.length === 1 ? "the rule" : "the rules"} to ${who}'s profile`}>Always allow &amp; retry</button>
      </div>
    </section>
  );
}
