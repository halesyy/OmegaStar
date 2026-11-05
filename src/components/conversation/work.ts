// The work behind a conversation, read from its runs: what each reply says in the talk (its first words, its answer),
// the chips that point from the talk to the work, the live cards (a colleague asked, a sub-agent) and the rows of steps
// for This turn and Earlier. Pure: the talk (ChatTurn) and the Live work column (LiveWork) read the same keys.
import type { EmployeeView, Run } from "../../api/types";
import { firstName } from "../../lib/format";
import type { LiveRun, TaskView } from "../../lib/runs";
import type { IconName } from "../Icon";
import { saidElsewhere, shortObject, skillWords, stepWords, toItems, type ToolItem, type TranscriptItem } from "../Transcript";

export type StepState = "pending" | "ok" | "err" | "stopped" | "wait" | null;
export type TextItem = Extract<TranscriptItem, { kind: "text" }>;

/** A row of the column: the verb, what it acted on, and how it ended. `detail` opens under it. */
export type WorkRow = {
  key: string; icon: IconName; verb: string; object: string; code: boolean; state: StepState;
  tag?: string; meta?: string; detail?: string; avatar?: { name: string; hue: number }; runId?: string;
};

/** A live card: a colleague the employee asked (its run) or a sub-agent, while it works. */
export type WorkCard =
  | { kind: "delegate"; key: string; childRunId: string; employee?: EmployeeView; task: string; asked: boolean; handoff: boolean; child?: Run }
  | { kind: "agent"; key: string; task: TaskView };

/** A chip in the talk, pointing at its card or row in the column (`target`), or opening something itself (`open`). */
export type Chip = { key: string; label: string; icon?: IconName; avatar?: { name: string; hue: number }; live: boolean; target: string | null; skill?: { skill: string; file: string } };

/** One stretch of a reply: what you said to start it (after the first), its items, and how the talk reads them. */
export type Part = { said: string | null; items: TranscriptItem[]; opener: TextItem | null; notes: TextItem[]; answer: TextItem[] };

export type WorkModel = { cards: WorkCard[]; turn: WorkRow[]; earlier: WorkRow[] };

export const isRunning = (r: Run) => r.state === "running" || r.state === "queued";
const live = (r?: Run) => !!r && isRunning(r);
const isWork = (it: TranscriptItem) => it.kind === "tools" || it.kind === "skill" || it.kind === "delegated" || it.kind === "requested" || it.kind === "proposed" || it.kind === "visual";

/** A reply split where a message you sent while it worked landed. In each part the talk keeps the first words (when they
 *  came before any work) and the answer (the words after the last of it); the notes between move to the column. */
export function partsOf(events: TranscriptItem[]): Part[] {
  const raw: { said: string | null; items: TranscriptItem[] }[] = [{ said: null, items: [] }];
  for (const it of events) {
    if (it.kind === "user") raw.push({ said: it.text, items: [] });
    else if (it.kind !== "init" && it.kind !== "stderr") raw[raw.length - 1].items.push(it);
  }
  return raw.map(({ said, items }) => {
    const texts = items.filter((it): it is TextItem => it.kind === "text");
    const work = items.flatMap((it, i) => (isWork(it) ? [i] : []));
    if (!work.length) return { said, items, opener: null, notes: [], answer: texts };
    const first = items[0];
    const opener = first?.kind === "text" && work[0] > 0 ? first : null;
    const last = work[work.length - 1];
    return {
      said, items, opener,
      notes: items.slice(opener ? 1 : 0, last).filter((it): it is TextItem => it.kind === "text"),
      answer: items.slice(last + 1).filter((it): it is TextItem => it.kind === "text"),
    };
  });
}

/** Keys shared by a chip, its card and its row. */
export const keys = {
  tool: (runId: string, id: string) => `t:${runId}:${id}`,
  agent: (runId: string, id: string) => `a:${runId}:${id}`,
  delegate: (childRunId: string) => `d:${childRunId}`,
  note: (runId: string, key: string) => `n:${runId}:${key}`,
  visual: (runId: string, id: string) => `v:${runId}:${id}`,
  skill: (runId: string, skill: string, file: string) => `s:${runId}:${skill}:${file}`,
};

/** Elapsed time in minutes, never ticking seconds: "<1 min", "3 min", "1 h 5 min". */
export function minutes(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

export const compactNumber = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const firstLine = (text: string) => text.trim().split(/\r?\n/).find((l) => l.trim())?.replace(/[*_`#>]/g, "").trim() ?? "";

const delegateVerb = (asked: boolean, handoff: boolean, name: string) => `${handoff ? "Handed to" : asked ? "Asked" : "Delegated to"} ${name}`;
const childState = (c?: Run): StepState => (!c ? null : c.state === "queued" ? "wait" : c.state === "running" ? "pending" : c.state === "succeeded" ? "ok" : c.state === "failed" || c.state === "lost" ? "err" : "stopped");
const taskState = (t: TaskView, runActive: boolean): StepState => (t.state === "running" ? (runActive ? "pending" : "stopped") : t.state === "done" ? "ok" : t.state === "failed" ? "err" : "stopped");
const toolState = (t: ToolItem, running: boolean): StepState => (t.result === null ? (running ? "pending" : "stopped") : t.result.ok ? "ok" : "err");
const agentTask = (turn: LiveRun, t: ToolItem) => turn.tasks.find((k) => k.toolUseId === t.id);

/** A write into a skill's own folder, which its skill change already says ("Wrote a skill price-changes"). */
const skillWrite = (t: ToolItem, skills: Set<string>) => /^(Write|Edit|MultiEdit)$/.test(t.tool) && [...skills].some((k) => t.brief.includes(`skills/${k}/`));
const skillsOf = (items: TranscriptItem[]) => new Set(items.flatMap((it) => (it.kind === "skill" ? [it.skill] : [])));
/** Steps listed as steps: tools, apart from those said by what came of them unless they failed, and sub-agents. */
const plainTools = (tools: ToolItem[], skills: Set<string>) => tools.filter((t) => t.tool !== "Agent" && (!saidElsewhere(t.tool) || t.result?.ok === false) && !(skillWrite(t, skills) && t.result?.ok !== false));

/** The live cards of a turn: colleagues it asked who are still at it, and sub-agents still running. */
function cardsOf(turn: LiveRun, employees: EmployeeView[]): WorkCard[] {
  const running = isRunning(turn.run);
  const out: WorkCard[] = [];
  for (const it of toItems(turn.events)) {
    if (it.kind !== "delegated") continue;
    const child = turn.children.find((c) => c.id === it.childRunId);
    if (live(child)) out.push({ kind: "delegate", key: keys.delegate(it.childRunId), childRunId: it.childRunId, employee: employees.find((e) => e.id === it.employeeId), task: it.task, asked: it.asked, handoff: it.handoff, child });
  }
  if (running && turn.run.state === "running") {
    for (const t of turn.tasks) if (t.state === "running") out.push({ kind: "agent", key: keys.agent(turn.run.id, t.id), task: t });
  }
  return out;
}

/** The rows of a turn, oldest first: its steps, its notes, what it handed over, showed or wrote. Anything still live is a
 *  card instead. */
function rowsOf(turn: LiveRun, employees: EmployeeView[]): WorkRow[] {
  const id = turn.run.id;
  const running = isRunning(turn.run);
  const items = toItems(turn.events);
  const notes = new Set(partsOf(items).flatMap((p) => p.notes.map((n) => n.key)));
  const skills = skillsOf(items);
  const seenTasks = new Set<string>();
  const out: WorkRow[] = [];
  const agentRow = (t: TaskView) => {
    seenTasks.add(t.id);
    const state = taskState(t, turn.run.state === "running");
    if (state === "pending") return;
    out.push({ key: keys.agent(id, t.id), icon: "layers", verb: "Sub-agent", object: t.name, code: false, state, meta: `${t.toolUses} ${t.toolUses === 1 ? "call" : "calls"} · ${minutes(t.durationMs)}`, runId: id });
  };
  for (const it of items) {
    switch (it.kind) {
      case "tools":
        for (const t of it.tools) {
          if (t.tool === "Agent") {
            const task = agentTask(turn, t);
            if (task) agentRow(task);
            continue;
          }
          if ((saidElsewhere(t.tool) || skillWrite(t, skills)) && t.result?.ok !== false) continue;
          const state = toolState(t, running);
          const w = stepWords(t.tool, t.brief, state === "pending");
          out.push({ key: keys.tool(id, t.id), icon: w.icon, verb: w.verb, object: w.object, code: w.code, state, detail: t.result?.brief, runId: id });
        }
        break;
      case "text":
        if (notes.has(it.key)) out.push({ key: keys.note(id, it.key), icon: "chat", verb: "Noted", object: firstLine(it.text), code: false, state: null, detail: it.text.trim(), runId: id });
        break;
      case "delegated": {
        const child = turn.children.find((c) => c.id === it.childRunId);
        if (live(child)) break;
        const e = employees.find((x) => x.id === it.employeeId);
        out.push({
          key: keys.delegate(it.childRunId), icon: it.asked ? "ask" : "branch", verb: delegateVerb(it.asked, it.handoff, e ? firstName(e.name) : "a colleague"),
          object: it.task, code: false, state: childState(child), avatar: e ? { name: e.name, hue: e.hue } : undefined, runId: it.childRunId,
        });
        break;
      }
      case "visual":
        out.push({ key: keys.visual(id, it.id), icon: "image", verb: "Showed", object: it.title, code: false, state: "ok", runId: id });
        break;
      case "skill": {
        const w = skillWords(it.skill, it.file, it.change);
        out.push({ key: keys.skill(id, it.skill, it.file), icon: "teach", verb: it.change === "added" ? "Wrote a skill" : w.verb, object: w.object, code: false, state: it.change === "added" ? null : "ok", tag: it.change === "added" ? "New" : undefined, runId: id });
        break;
      }
      default: break;
    }
  }
  // Sub-agents whose call was not recorded (an old transcript) still get a row.
  for (const t of turn.tasks) if (!seenTasks.has(t.id)) agentRow(t);
  return out;
}

/** The column for a conversation: the live cards, newest first; This turn (the latest reply) and Earlier, each newest
 *  first, so a new step arrives at the top and carries the rows below it. */
export function workOf(turns: LiveRun[], employees: EmployeeView[]): WorkModel {
  const cards = turns.flatMap((t) => cardsOf(t, employees)).reverse();
  const rows = turns.map((t) => rowsOf(t, employees));
  // Newest first; a colleague or sub-agent that finished came back after the steps around it, so it leads.
  const order = (list: WorkRow[]) => {
    const back = [...list].reverse();
    return [...back.filter((r) => r.key.startsWith("d:") || r.key.startsWith("a:")), ...back.filter((r) => !r.key.startsWith("d:") && !r.key.startsWith("a:"))];
  };
  return { cards, turn: order(rows[rows.length - 1] ?? []), earlier: order(rows.slice(0, -1).flat()) };
}

/** The chips of one part of a reply: each colleague asked, each sub-agent, each skill written, then the steps (up to two
 *  by name, otherwise "6 steps"). */
export function chipsOf(part: Part, turn: LiveRun, employees: EmployeeView[]): Chip[] {
  const id = turn.run.id;
  const running = isRunning(turn.run);
  const chips: Chip[] = [];
  const steps: { key: string; label: string; live: boolean; icon?: IconName }[] = [];
  const notes = new Set(part.notes.map((n) => n.key));
  for (const it of part.items) {
    if (it.kind === "delegated") {
      const child = turn.children.find((c) => c.id === it.childRunId);
      const e = employees.find((x) => x.id === it.employeeId);
      chips.push({ key: keys.delegate(it.childRunId), label: delegateVerb(it.asked, it.handoff, e ? firstName(e.name) : "a colleague"), icon: it.asked ? "ask" : "branch", avatar: e ? { name: e.name, hue: e.hue } : undefined, live: live(child), target: keys.delegate(it.childRunId) });
    } else if (it.kind === "skill") {
      const w = skillWords(it.skill, it.file, it.change);
      chips.push({ key: keys.skill(id, it.skill, it.file), label: `${w.verb} ${w.object}`, icon: "teach", live: false, target: keys.skill(id, it.skill, it.file), skill: { skill: it.skill, file: it.file } });
    } else if (it.kind === "tools") {
      for (const t of it.tools) {
        if (t.tool === "Agent") {
          const task = agentTask(turn, t);
          const k = task ? keys.agent(id, task.id) : keys.tool(id, t.id);
          chips.push({ key: k, label: "Sub-agent", icon: "layers", live: !!task && task.state === "running" && turn.run.state === "running", target: k });
        }
      }
      for (const t of plainTools(it.tools, skillsOf(toItems(turn.events)))) {
        const state = toolState(t, running);
        const w = stepWords(t.tool, t.brief, state === "pending");
        steps.push({ key: keys.tool(id, t.id), label: `${w.verb} ${shortObject(t.tool, t.brief)}`.trim(), live: state === "pending", icon: w.icon });
      }
    } else if (it.kind === "text" && notes.has(it.key)) {
      steps.push({ key: keys.note(id, it.key), label: "", live: false });
    }
  }
  const named = steps.filter((s) => s.label);
  if (steps.length && steps.length <= 2 && named.length === steps.length) {
    for (const s of steps) chips.push({ key: s.key, label: s.label, live: s.live, target: s.key, icon: s.icon });
  } else if (steps.length) {
    chips.push({ key: `steps:${steps[0].key}`, label: `${steps.length} steps`, icon: "checklist", live: steps.some((s) => s.live), target: steps[steps.length - 1].key });
  }
  return chips;
}
