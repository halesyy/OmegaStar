import { useState } from "react";
import type { EmployeeView, HireProposal, HumanRequest, PersonView, RequestKind, Run, RunEvent, SkillChangeKind } from "../api/types";
import { runStateLabel, runStateTone, firstName } from "../lib/format";
import type { TaskView } from "../lib/runs";
import { navigate, openRun } from "../lib/router";
import { Icon, type IconName } from "./Icon";
import { Avatar, StatePill } from "./ui";
import "./Transcript.css";

export type TranscriptItem =
  | { kind: "text"; key: string; text: string }
  | { kind: "user"; key: string; text: string; waiting?: boolean }
  | { kind: "tools"; key: string; tools: ToolItem[] }
  | { kind: "skill"; key: string; skill: string; file: string; change: SkillChangeKind }
  | { kind: "delegated"; key: string; childRunId: string; employeeId: string; task: string; asked: boolean; handoff: boolean }
  | { kind: "requested"; key: string; requestId: string; personId: string; reqKind: RequestKind; message: string }
  | { kind: "proposed"; key: string; proposalId: string; name: string; title: string }
  | { kind: "visual"; key: string; id: string; title: string }
  | { kind: "init"; key: string; model: string; skills: string[] }
  | { kind: "result"; key: string; ok: boolean; text: string; turns: number; durationMs: number }
  | { kind: "stderr"; key: string; text: string };
export type ToolItem = { id: string; tool: string; brief: string; result: { ok: boolean; brief: string } | null };

/** Fold raw events into display items: pair tool calls with results, group consecutive tools. A message you sent while
 *  the employee worked reads where they took it (its `heard`), as Claude Code shows a queued message once it goes in;
 *  until then it waits at the end. One from an older build, with no id, reads where it was sent. */
export function toItems(events: RunEvent[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const toolIndex = new Map<string, ToolItem>();
  const sent = new Map(events.flatMap((ev) => (ev.type === "user" && ev.id ? [[ev.id, ev.text] as const] : [])));
  const heard = new Set(events.flatMap((ev) => (ev.type === "heard" ? [ev.id] : [])));
  events.forEach((ev, i) => {
    const key = `e${i}`;
    switch (ev.type) {
      case "text": out.push({ kind: "text", key, text: ev.text }); break;
      case "user": if (!ev.id) out.push({ kind: "user", key, text: ev.text }); break;
      case "heard": { const text = sent.get(ev.id); if (text !== undefined) out.push({ kind: "user", key, text }); break; }
      case "textDelta": break;
      case "toolCall": {
        const t: ToolItem = { id: ev.id, tool: ev.tool, brief: ev.brief, result: null };
        toolIndex.set(ev.id, t);
        const last = out[out.length - 1];
        if (last && last.kind === "tools") last.tools.push(t);
        else out.push({ kind: "tools", key, tools: [t] });
        break;
      }
      case "toolResult": {
        const t = toolIndex.get(ev.id);
        if (t) t.result = { ok: ev.ok, brief: ev.brief };
        break;
      }
      case "skillChanged": out.push({ kind: "skill", key, skill: ev.skill, file: ev.file, change: ev.change }); break;
      case "delegated": out.push({ kind: "delegated", key, childRunId: ev.childRunId, employeeId: ev.employeeId, task: ev.task, asked: false, handoff: false }); break;
      case "asked": out.push({ kind: "delegated", key, childRunId: ev.childRunId, employeeId: ev.employeeId, task: ev.question, asked: true, handoff: !!ev.task }); break;
      case "requested": out.push({ kind: "requested", key, requestId: ev.requestId, personId: ev.personId, reqKind: ev.kind, message: ev.message }); break;
      case "proposedHire": out.push({ kind: "proposed", key, proposalId: ev.proposalId, name: ev.name, title: ev.title }); break;
      case "visual": out.push({ kind: "visual", key, id: ev.id, title: ev.title }); break;
      case "init": out.push({ kind: "init", key, model: ev.model, skills: ev.skills }); break;
      case "result": out.push({ kind: "result", key, ok: ev.ok, text: ev.text, turns: ev.turns, durationMs: ev.durationMs }); break;
      case "stderr": out.push({ kind: "stderr", key, text: ev.text }); break;
      // Sub-agents are shown by SubAgents from the tasks foldEvent keeps, not as transcript items.
      case "taskStarted": case "taskProgress": case "taskEnded": break;
      default: { const never: never = ev; void never; }
    }
  });
  for (const [id, text] of sent) if (!heard.has(id)) out.push({ kind: "user", key: `w${id}`, text, waiting: true });
  return out;
}

/** How a step reads: its verb once done ("Read"), while it runs ("Reading"), its icon, and whether what it acted on is a
 *  path or a command (set in mono). Anything not listed reads as its own name. */
type StepMeta = { done: string; now: string; icon: IconName; code?: boolean };
const STEPS: Record<string, StepMeta> = {
  mcp__omega__delegate: { done: "Delegated", now: "Delegating", icon: "branch" },
  mcp__omega__colleagues: { done: "Checked colleagues", now: "Checking colleagues", icon: "org" },
  mcp__omega__ask_colleague: { done: "Asked a colleague", now: "Asking a colleague", icon: "ask" },
  mcp__omega__await_reports: { done: "Waited for reports", now: "Waiting for reports", icon: "clock" },
  mcp__omega__team: { done: "Checked the team", now: "Checking the team", icon: "org" },
  mcp__omega__people: { done: "Looked up people", now: "Looking up people", icon: "person" },
  mcp__omega__request: { done: "Asked a person", now: "Asking a person", icon: "ask" },
  mcp__omega__my_requests: { done: "Checked requests", now: "Checking requests", icon: "ask" },
  mcp__omega__update_request: { done: "Updated a request", now: "Updating a request", icon: "ask" },
  mcp__omega__catalog: { done: "Browsed skills", now: "Browsing skills", icon: "layers" },
  mcp__omega__propose_hire: { done: "Proposed a hire", now: "Proposing a hire", icon: "userPlus" },
  mcp__omega__my_proposals: { done: "Checked proposals", now: "Checking proposals", icon: "userPlus" },
  mcp__omega__withdraw_proposal: { done: "Withdrew a proposal", now: "Withdrawing a proposal", icon: "userPlus" },
  mcp__omega__show: { done: "Showed", now: "Showing", icon: "image" },
  Agent: { done: "Sub-agent", now: "Sub-agent", icon: "layers" },
  Skill: { done: "Used skill", now: "Using skill", icon: "teach" },
  Read: { done: "Read", now: "Reading", icon: "file", code: true },
  Edit: { done: "Edited", now: "Editing", icon: "edit", code: true },
  MultiEdit: { done: "Edited", now: "Editing", icon: "edit", code: true },
  Write: { done: "Wrote", now: "Writing", icon: "edit", code: true },
  NotebookEdit: { done: "Edited", now: "Editing", icon: "edit", code: true },
  Bash: { done: "Ran", now: "Running", icon: "tool", code: true },
  Grep: { done: "Searched", now: "Searching", icon: "search", code: true },
  Glob: { done: "Found files", now: "Finding files", icon: "search", code: true },
  LS: { done: "Listed", now: "Listing", icon: "folder", code: true },
  WebFetch: { done: "Fetched", now: "Fetching", icon: "link", code: true },
  WebSearch: { done: "Searched the web", now: "Searching the web", icon: "search" },
  TodoWrite: { done: "Updated the plan", now: "Updating the plan", icon: "checklist" },
};
/** "list_tickets" or "listTickets" -> "List tickets": a tool with no words of its own, said as words. */
const humanize = (name: string) => {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
};
const stepMeta = (tool: string): StepMeta => STEPS[tool] ?? { done: humanize(toolName(tool)), now: humanize(toolName(tool)), icon: "tool" };
/** Words that start a phrase rather than name something, so an object continuing the verb takes them in lower case
 *  ("Looked up people who owns billing"). */
const LEADS = new Set(["who", "what", "which", "where", "when", "why", "how", "the", "a", "an", "any", "all", "every", "each", "this", "that", "these", "those", "is", "are", "does", "do", "can", "could", "should", "would", "will", "find", "check", "look"]);
const continuing = (brief: string) => {
  const first = brief.match(/^([A-Z][a-z]+)\b/)?.[1];
  return first && LEADS.has(first.toLowerCase()) ? first.toLowerCase() + brief.slice(first.length) : brief;
};
/** A search as words: `"\$29" in help-centre/` -> the pattern unescaped and where it looked. */
const searchOf = (brief: string) => {
  const m = /^"(.*)"\s+in\s+(.+)$/.exec(brief.trim());
  return m ? { pattern: m[1].replace(/\\(.)/g, "$1"), where: m[2] } : null;
};
/** "mcp__claude_ai_Atlassian_Rovo__searchConfluenceUsingCql" -> "searchConfluenceUsingCql" */
export const toolName = (tool: string) => tool.replace(/^mcp__.+?__/, "");

/** A step in words: "Read" and "templates/customer-email.md" (mono), or "Reading" while it runs. */
export function stepWords(tool: string, brief: string, running = false): { verb: string; object: string; icon: IconName; code: boolean } {
  const m = stepMeta(tool);
  const verb = running ? m.now : m.done;
  const search = tool === "Grep" ? searchOf(brief) : null;
  if (search) return { verb, object: `${search.where} for ${search.pattern}`, icon: m.icon, code: false };
  return { verb, object: m.code ? brief : continuing(brief), icon: m.icon, code: !!m.code };
}

/** What a step acted on, short enough for a chip: a path's file name, a command's first two words. */
export function shortObject(tool: string, brief: string): string {
  // A chip says the step in a few words; the column's row says the rest. Steps whose object is prose read as their verb.
  const search = tool === "Grep" ? searchOf(brief) : null;
  if (search) return `for ${search.pattern}`;
  const m = stepMeta(tool);
  if (!m.code || !STEPS[tool]) return "";
  if (tool === "Bash") return brief.trim().split(/\s+/).slice(0, 2).join(" ");
  const path = brief.trim().split(/\s+/)[0] ?? brief;
  return path.split("/").filter(Boolean).pop() ?? brief;
}

/** Steps that are said by what came of them (a hand-off, a page shown), so they are not listed as steps too. */
export const saidElsewhere = (tool: string) =>
  tool === "mcp__omega__delegate" || tool === "mcp__omega__ask_colleague" || tool === "mcp__omega__show" || tool === "mcp__omega__request" || tool === "mcp__omega__propose_hire";

type RowStatus = "pending" | "ok" | "err" | "stopped" | null;

/**
 * The steps of a run as one-line rows: the verb, then what it acted on, then a tick, a cross or a still dot while it
 * runs. A row opens to show the call and what came back. `tasks` are the run's sub-agents: an `Agent` call returns
 * "launched" at once and its agent goes on working, so that row shows the agent's own state instead of a tick.
 */
export function ToolRows({ tools, running, compact = false, tasks = [] }: { tools: ToolItem[]; running: boolean; compact?: boolean; tasks?: TaskView[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const limit = compact ? 3 : 6;
  const hidden = tools.length > limit + 1 && !expanded ? tools.length - limit : 0;
  const shown = hidden ? tools.slice(tools.length - limit) : tools;
  return (
    <div className={`tools ${compact ? "tools-compact" : ""}`}>
      {hidden ? (
        <button className="tool-more" onClick={() => setExpanded(true)}>
          <Icon name="more" size={14} /> {hidden} earlier {hidden === 1 ? "step" : "steps"}
        </button>
      ) : null}
      {shown.map((t) => {
        const task = t.tool === "Agent" ? tasks.find((k) => k.toolUseId === t.id) : undefined;
        // The row's status: a launched agent answers for itself, so "launched" is never shown as done.
        const status: RowStatus = task
          ? task.state === "running" ? (running ? "pending" : "stopped") : task.state === "done" ? "ok" : task.state === "failed" ? "err" : "stopped"
          : t.result === null && running ? "pending" : t.result ? (t.result.ok ? "ok" : "err") : null;
        const w = stepWords(t.tool, task?.name ?? t.brief, status === "pending");
        const isOpen = open === t.id;
        return (
          <div key={t.id} className={`tool ${isOpen ? "tool-open" : ""}`}>
            <button className="tool-row" onClick={() => setOpen(isOpen ? null : t.id)} aria-expanded={isOpen}>
              <Icon name={w.icon} size={14} className="tool-icon" />
              <span className="tool-text">
                <span className="tool-name">{w.verb}</span>
                <span className={`tool-brief ${w.code ? "mono" : ""}`}>{w.object}</span>
              </span>
              <StepMark status={status} />
            </button>
            <div className="collapse" data-open={isOpen}>
              <div>
                <div className="tool-detail">
                  <div><span className="mono muted">{toolName(t.tool)}</span> <span className={w.code ? "mono" : ""}>{t.brief}</span></div>
                  {task ? (
                    <div className={task.state === "failed" ? "tool-err-text" : ""}>→ {task.state === "running" ? (running ? "running in the background" : "ended with the run") : task.state === "done" ? "finished" : task.state === "failed" ? "failed" : "stopped"}</div>
                  ) : t.result ? <div className={t.result.ok ? "" : "tool-err-text"}>→ {t.result.brief}</div> : <div className="muted">→ waiting…</div>}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A step's state at the end of its row: a tick, a cross, a still ultramarine dot while it runs, a hollow ring when it
 *  ended with its run. */
export function StepMark({ status }: { status: RowStatus | "wait" }) {
  return (
    <span className="tool-status" aria-label={status === "pending" ? "Working" : status === "ok" ? "Done" : status === "err" ? "Failed" : status === "wait" ? "Up next" : status === "stopped" ? "Ended with the run" : undefined}>
      {status === "pending" ? <span className="tool-pending" />
        : status === "ok" ? <Icon name="check" size={13} className="tool-ok" />
        : status === "err" ? <Icon name="close" size={13} className="tool-err" />
        : status === "stopped" || status === "wait" ? <span className="tool-stopped" />
        : null}
    </span>
  );
}

const SKILL_VERB: Record<SkillChangeKind, string> = { added: "Wrote", removed: "Trimmed", modified: "Refined" };
/** What a skill change says: "Wrote", "Refined" or "Trimmed", then the skill (and its file, when not SKILL.md). */
export const skillWords = (skill: string, file: string, change: SkillChangeKind) => ({ verb: SKILL_VERB[change] ?? "Refined", object: `${skill}${file !== "SKILL.md" ? `/${file}` : ""}` });

export function SkillChip({ skill, file, change, onClick }: { skill: string; file: string; change: SkillChangeKind; onClick?: () => void }) {
  const w = skillWords(skill, file, change);
  return (
    <button className="skill-chip" onClick={onClick} disabled={!onClick} data-tip={onClick ? "See what changed" : undefined}>
      <Icon name="teach" size={14} />
      <span className="skill-chip-verb">{w.verb}</span>
      <span className="skill-chip-name">{w.object}</span>
    </button>
  );
}

export function DelegatedCard({ childRunId, employeeId, task, employees, child, asked = false, handoff = false }: { childRunId: string; employeeId: string; task: string; employees: EmployeeView[]; child: Run | undefined; asked?: boolean; handoff?: boolean }) {
  const e = employees.find((x) => x.id === employeeId);
  return (
    <button className="delegated" onClick={() => openRun(childRunId)}>
      <span className="delegated-top">
        {e ? <Avatar name={e.name} hue={e.hue} image={e.image} size={22} /> : <Icon name={asked ? "ask" : "branch"} size={14} className="muted" />}
        <span className="delegated-who"><span className="muted">{handoff ? "Handed a task to" : asked ? "Asked" : "Delegated to"}</span> <b>{e ? e.name : asked ? "a colleague" : "a report"}</b></span>
        <span className="grow" />
        {child ? <StatePill tone={runStateTone(child)}>{runStateLabel(child.state)}</StatePill> : null}
        <Icon name="arrowRight" size={13} className="delegated-go" />
      </span>
      <span className="delegated-task">{task}</span>
    </button>
  );
}

const REQUESTED_HEAD: Record<RequestKind, { verb: string; tail: string }> = {
  question: { verb: "Asked", tail: " a question" },
  task: { verb: "Asked", tail: " to do something" },
  info: { verb: "Told", tail: "" },
};

export function RequestedRow({ personId, reqKind, message, people, request }: { personId: string; reqKind: RequestKind; message: string; people: PersonView[]; request?: HumanRequest }) {
  const p = people.find((x) => x.id === personId);
  const name = p ? firstName(p.name) : "someone";
  const channel = p && request?.channelId ? p.channels.find((c) => c.id === request.channelId) : undefined;
  const state = request?.state;
  const head = REQUESTED_HEAD[reqKind];
  return (
    <div className="requested">
      {p ? <Avatar name={p.name} hue={p.hue} image={p.image} size={22} person /> : <Icon name={reqKind === "info" ? "bell" : "ask"} size={14} className="requested-icon" />}
      <div className="requested-main">
        <span className="requested-head">
          {head.verb} <b>{name}</b>{head.tail}
          {channel ? <span className="muted"> · via {channel.address}</span> : null}
        </span>
        <span className="requested-msg">{message}</span>
        {request?.response ? <span className="requested-reply"><b>{name}:</b> {request.response}</span> : null}
      </div>
      {reqKind === "info" ? (
        <span className="pill pill-outline">FYI</span>
      ) : state ? (
        <span className={`pill ${state === "open" ? "pill-wait" : state === "cancelled" ? "" : "pill-ok"}`}>
          {state === "open" ? "Waiting" : state === "answered" ? "Answered" : state === "done" ? "Done" : "Cancelled"}
        </span>
      ) : null}
    </div>
  );
}

const PROPOSAL_STATE: Record<HireProposal["state"], string> = { open: "Waiting on you", approved: "Hired", declined: "Declined", withdrawn: "Withdrawn" };

export function ProposedRow({ name, title, proposal }: { name: string; title: string; proposal?: HireProposal }) {
  const state = proposal?.state;
  return (
    <div className="requested">
      <Avatar name={name} hue={210} size={22} proposed />
      <div className="requested-main">
        <span className="requested-head">Proposed a hire: <b>{name}</b>, {title}</span>
        {proposal?.note ? <span className="requested-reply"><b>Your note:</b> {proposal.note}</span> : null}
      </div>
      {state === "open" ? (
        <button className="btn btn-sm" onClick={() => navigate({ page: "inbox" })}>Review <Icon name="arrowRight" size={12} /></button>
      ) : state ? (
        <span className={`pill ${state === "approved" ? "pill-ok" : ""}`}>{PROPOSAL_STATE[state]}</span>
      ) : null}
    </div>
  );
}
