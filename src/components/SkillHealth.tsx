import { useState, type ReactNode } from "react";
import { call, errorMessage } from "../api/client";
import type { Check, EmployeeView, HealthFinding, HealthKind, SkillHealth as Health } from "../api/types";
import { capitalize, firstName, relTime } from "../lib/format";
import { useQuery } from "../lib/hooks";
import { toast } from "../lib/toasts";
import { openMember, openRun } from "../lib/router";
import { isLive } from "../lib/threads";
import { Icon } from "./Icon";
import { ConfirmButton, Section } from "./ui";
import "./SkillHealth.css";

const LABEL: Record<HealthKind, string> = {
  overdueCheck: "Check overdue",
  dangling: "Broken pointer",
  unreachable: "Not reachable",
  looseNotes: "Unfinished notes",
  churn: "Rewritten repeatedly",
  repeatedEntries: "Diary building up",
  tooLong: "Getting long",
  unused: "Not used lately",
  datedLines: "Dated lines in a procedure",
  descriptionsHeavy: "Descriptions are heavy",
  description: "Description",
  junk: "Leftover files",
  nameMismatch: "Name mismatch",
};

/** Broken structure is worth a warning colour; the rest is housekeeping. */
const BROKEN: HealthKind[] = ["overdueCheck", "dangling", "unreachable"];

function Finding({ f, onOpenFile }: { f: HealthFinding; onOpenFile: (skill: string, file: string) => void }) {
  const where = f.skill ? `${f.skill}${f.file && f.file !== "SKILL.md" ? ` / ${f.file}` : ""}` : f.file;
  return (
    <li className="hf-row">
      <div className="hf-body">
        {f.skill ? (
          <button className="hf-where mono" onClick={() => onOpenFile(f.skill!, f.file ?? "SKILL.md")}>{where}</button>
        ) : where ? (
          <span className="hf-where mono">{where}</span>
        ) : null}
        <span className="hf-detail">{f.detail}</span>
      </div>
      <span className={`tag hf-kind ${BROKEN.includes(f.kind) ? "tag-warn" : ""}`}>{LABEL[f.kind]}</span>
    </li>
  );
}

/** A list that folds under its one-line summary and opens its own space, so what is below moves with it. It starts open
 *  when something in it is overdue or broken; after that it is yours to open and close. */
function Fold({ summary, startOpen, children }: { summary: ReactNode; startOpen: boolean; children: ReactNode }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? startOpen;
  return (
    <div className="upkeep-fold">
      <button type="button" className="upkeep-summary" aria-expanded={open} onClick={() => setChosen(!open)}>
        <Icon name="chevronRight" size={12} className="upkeep-chev" />
        <span>{summary}</span>
      </button>
      <div className="collapse" data-open={open} inert={!open}>
        <div>{children}</div>
      </div>
    </div>
  );
}

const DAY_MS = 86_400_000;

/** "2 days overdue", "due today", "in 4 days". */
function dueLabel(c: Check, now = Date.now()): { text: string; late: boolean } {
  const ms = Date.parse(c.dueAt) - now;
  if (ms <= 0) {
    const late = Math.floor(-ms / DAY_MS);
    return { text: late === 0 ? "due today" : late === 1 ? "a day overdue" : `${late} days overdue`, late: true };
  }
  const days = Math.floor(ms / DAY_MS);
  return { text: days === 0 ? "due later today" : days === 1 ? "due tomorrow" : `due in ${days} days`, late: false };
}

/**
 * How an employee keeps their own skills in order, at the foot of the Skills tab: when they last tidied,
 * what they promised to look at again, and what Omega Star finds worth a look. The lists stay folded
 * unless something is overdue or broken.
 */
export function Upkeep({ e, health, onOpenFile }: { e: EmployeeView; health: Health; onOpenFile: (skill: string, file: string) => void }) {
  const name = firstName(e.name);
  const runs = useQuery(() => call("tidy_runs", { employeeId: e.id }), [e.id], ["run:updated"]);
  const checks = useQuery(() => call("checks", { employeeId: e.id }), [e.id], ["org:changed"]);
  const [busy, setBusy] = useState(false);
  const open = (checks.data ?? []).filter((c) => c.state === "open");
  const overdue = open.filter((c) => dueLabel(c).late).length;
  const active = (runs.data ?? []).find(isLive);
  const last = (runs.data ?? []).find((r) => !isLive(r));
  const waiting = last && last.proposed && !last.approvedAt && !last.archivedAt ? last : undefined;
  // Overdue checks are listed with their dates, so they are not repeated in the findings.
  const findings = health.findings.filter((f) => f.kind !== "overdueCheck");
  const broken = findings.some((f) => BROKEN.includes(f.kind));
  const tidyNow = async () => {
    setBusy(true);
    try {
      await call("tidy", { employeeId: e.id });
      toast(`${name} is tidying now`, "ok");
    } catch (x) {
      toast(errorMessage(x), "err");
    } finally {
      setBusy(false);
    }
  };
  const drop = async (id: string) => {
    try { await call("drop_check", { checkId: id }); } catch (x) { toast(errorMessage(x), "err"); }
  };
  const when = active ? `${name} is tidying now.` : last ? `Last tidied ${relTime(last.endedAt ?? last.createdAt)}.` : "Not tidied yet.";
  const how = e.autoTidy ? "Tidies on their own when something needs it." : "Automatic tidying is off.";
  return (
    <Section
      title="Upkeep"
      action={active ? (
        <button className="section-note linkish" onClick={() => openRun(active.id)}>{active.state === "queued" ? "Queued" : "Watch"} <Icon name="arrowUpRight" size={11} /></button>
      ) : waiting ? null : (
        <button className="section-note linkish" disabled={busy} onClick={() => void tidyNow()}>Tidy now</button>
      )}
    >
      <p className="upkeep-line">
        {when} {how}{" "}
        {e.autoTidy ? null : <button className="linkish" onClick={() => openMember(e.id, "profile", null, true)}>Turn it on</button>}
        {findings.length === 0 && open.length === 0 && !waiting ? " Nothing to tidy right now." : null}
      </p>
      {waiting ? (
        <div className="upkeep-wait">
          <span className="grow">{name} proposes bigger changes to their skills. Nothing changes until you approve.</span>
          <button className="btn btn-sm btn-primary" onClick={() => openRun(waiting.id)}>Review</button>
        </div>
      ) : null}
      {open.length > 0 ? (
        <Fold
          startOpen={overdue > 0}
          summary={<>{open.length === 1 ? `1 thing ${name} will check again` : `${open.length} things ${name} will check again`}{overdue ? <span className="upkeep-late"> · {overdue} overdue</span> : null}</>}
        >
          <ul className="hf-list">
            {open.map((c) => {
              const due = dueLabel(c);
              return (
                <li key={c.id} className="hf-row chk-row">
                  <div className="hf-body">
                    <span className="chk-what">{c.what}</span>
                    <span className="hf-detail"><span className={due.late ? "upkeep-late" : ""}>{capitalize(due.text)}</span> · {c.how}</span>
                  </div>
                  <ConfirmButton label="Drop" className="btn btn-ghost" size="btn-sm" question="Stop tracking it?" confirmLabel="Drop it" onConfirm={() => drop(c.id)} />
                </li>
              );
            })}
          </ul>
        </Fold>
      ) : null}
      {findings.length > 0 ? (
        <Fold startOpen={broken} summary={<>{findings.length === 1 ? "1 thing worth tidying" : `${findings.length} things worth tidying`}<span className="upkeep-quiet"> · found by Omega Star, nothing changed</span></>}>
          <ul className="hf-list">
            {findings.map((f, i) => <Finding key={`${f.kind}~${f.skill}~${f.file}~${i}`} f={f} onOpenFile={onOpenFile} />)}
          </ul>
        </Fold>
      ) : null}
    </Section>
  );
}
