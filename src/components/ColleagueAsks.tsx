import type { EmployeeView, Run } from "../api/types";
import { duration, elapsedMs, firstName } from "../lib/format";
import { useNow } from "../lib/hooks";
import { openRun } from "../lib/router";
import { Icon } from "./Icon";
import { Avatar } from "./ui";
import "./ColleagueAsks.css";

/** One ask between two employees that has not come back yet: who asked whom, what, and how far along it is. */
export function AskRow({ run, employees }: { run: Run; employees: EmployeeView[] }) {
  const live = run.state === "running";
  const now = useNow(1000, live);
  const kind = run.kind;
  if (kind.type !== "asked") return null;
  const asker = employees.find((x) => x.id === kind.askedBy);
  const to = employees.find((x) => x.id === run.employeeId);
  const task = kind.task;
  // A word first, its dot saying the same: working, up next (waiting to start), or answered and not picked up yet.
  const [state, tone] = live ? [`Working · ${duration(elapsedMs(run, now))}`, "status-live"]
    : run.state === "queued" ? ["Up next", "status-wait"]
    : ["Answered, not picked up yet", "status-plain"];
  return (
    <button className="ask-row" onClick={() => openRun(run.id)}>
      <span className="ask-pair">
        {asker ? <Avatar name={asker.name} hue={asker.hue} image={asker.image} size={26} /> : <span className="ask-noav" />}
        <Icon name="arrowRight" size={12} className="ask-arrow" />
        {to ? <Avatar name={to.name} hue={to.hue} image={to.image} size={26} presence={live ? "working" : undefined} /> : <span className="ask-noav" />}
      </span>
      <span className="ask-main">
        <span className="ask-who">
          <b>{asker ? firstName(asker.name) : "Someone"}</b> {task ? "handed a task to" : "asked"} <b>{to ? firstName(to.name) : "a former colleague"}</b>
        </span>
        <span className="ask-text">{run.prompt}</span>
      </span>
      <span className={`ask-state status ${tone} num`}>{state}</span>
    </button>
  );
}
