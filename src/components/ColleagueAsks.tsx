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
  const state = live ? `Working · ${duration(elapsedMs(run, now))}` : run.state === "queued" ? "Waiting for a turn" : "Answered, not picked up yet";
  return (
    <button className="ask-row" onClick={() => openRun(run.id)}>
      <span className="ask-pair">
        {asker ? <Avatar name={asker.name} hue={asker.hue} size={26} /> : <span className="ask-noav" />}
        <Icon name="arrowRight" size={12} className="ask-arrow" />
        {to ? <Avatar name={to.name} hue={to.hue} size={26} presence={live ? "working" : undefined} /> : <span className="ask-noav" />}
      </span>
      <span className="ask-main">
        <span className="ask-who">
          <b>{asker ? firstName(asker.name) : "Someone"}</b> {task ? "handed a task to" : "asked"} <b>{to ? firstName(to.name) : "a former colleague"}</b>
        </span>
        <span className="ask-text">{run.prompt}</span>
      </span>
      <span className={`ask-state mono num ${live ? "ask-state-live" : ""}`}>{state}</span>
    </button>
  );
}
