import { useState } from "react";
import { duration } from "../lib/format";
import type { TaskView } from "../lib/runs";
import { Icon } from "./Icon";
import { toolName } from "./Transcript";
import "./SubAgents.css";

const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Glyph({ state }: { state: TaskView["state"] }) {
  if (state === "running") return <span className="tool-pending" />;
  if (state === "done") return <Icon name="check" size={12} className="tool-ok" />;
  if (state === "failed") return <Icon name="close" size={12} className="tool-err" />;
  return <span className="tool-stopped" />;
}

function rowLine(t: TaskView): string {
  switch (t.state) {
    case "running": return t.activity || (t.lastTool ? `Using ${toolName(t.lastTool)}` : "Starting…");
    case "done": return "Finished";
    case "failed": return "Failed";
    case "stopped": return "Ended with the run";
  }
}

/**
 * The sub-agents an employee started, with what each is doing now. A sub-agent cannot outlive its
 * run, so anything still going when the run is over is shown as ended with it.
 */
export function SubAgents({ tasks, runActive, defaultOpen = true }: { tasks: TaskView[]; runActive: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (tasks.length === 0) return null;
  const shown = tasks.map((t): TaskView => (t.state === "running" && !runActive ? { ...t, state: "stopped" } : t));
  const count = (s: TaskView["state"]) => shown.filter((t) => t.state === s).length;
  const running = count("running");
  const failed = count("failed");
  const stopped = count("stopped");
  const title = running
    ? running === shown.length ? `${plural(running, "sub-agent")} running` : `${running} of ${plural(shown.length, "sub-agent")} running`
    : [plural(shown.length, "sub-agent"), failed || stopped ? [count("done") && `${count("done")} finished`, failed && `${failed} failed`, stopped && `${stopped} stopped`].filter(Boolean).join(" · ") : "finished"].join(" · ");
  const calls = shown.reduce((n, t) => n + t.toolUses, 0);
  const tokens = shown.reduce((n, t) => n + t.tokens, 0);
  return (
    <div className={`sa ${open ? "sa-open" : ""}`}>
      <button type="button" className="sa-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronRight" size={12} className="sa-chev" />
        <Glyph state={running ? "running" : failed ? "failed" : "done"} />
        <span className="sa-title" aria-live="polite">{title}</span>
        <span className="sa-totals">{plural(calls, "call")} · {compact(tokens)} tokens</span>
      </button>
      {open ? (
        <ul className="sa-list">
          {shown.map((t) => (
            <li key={t.id} className={`sa-row sa-${t.state}`}>
              <span className="sa-glyph"><Glyph state={t.state} /></span>
              <span className="sa-main">
                <span className="sa-name" title={t.name}>{t.name}</span>
                <span className="sa-line" title={rowLine(t)}>{rowLine(t)}</span>
              </span>
              <span className="sa-stats">{plural(t.toolUses, "call")} · {duration(t.durationMs)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
