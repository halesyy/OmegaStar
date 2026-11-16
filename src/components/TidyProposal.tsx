import { useState } from "react";
import { call, errorMessage } from "../api/client";
import type { EmployeeView, Run } from "../api/types";
import { firstName } from "../lib/format";
import { tidyAsks } from "../lib/threads";
import { toast } from "../lib/toasts";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import "./TidyProposal.css";

/**
 * The bigger changes a tidy wants to make: splitting, merging, renaming or retiring a skill, or
 * changing a rule you taught. It only proposes them; approving starts a second run that makes exactly these.
 * A reply in its thread can revise them first, so while one is being answered they wait.
 */
export function TidyProposal({ run, employee, answering, onReply }: {
  run: Run;
  employee: EmployeeView | undefined;
  /** A reply in its thread is still being answered, and may change the plan. */
  answering: boolean;
  /** Puts the caret in the thread's composer. */
  onReply: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Asking about it decides nothing. An archived one waits until you reopen it, so one an older build approved stays approved.
  if (!tidyAsks(run)) return null;
  const name = employee ? firstName(employee.name) : "They";
  const approve = async () => {
    setBusy(true);
    try {
      await call("approve_tidy", { runId: run.id });
      toast(`${name} is making those changes now`, "ok");
    } catch (x) {
      toast(errorMessage(x), "err");
      setBusy(false);
    }
  };
  return (
    <section className="tp" aria-label={`${name}'s proposed changes`}>
      <div className="tp-head"><Icon name="checklist" size={15} /> {name} proposes bigger changes</div>
      <p className="tp-lead">Nothing has changed yet. These could move or lose something, so they wait for you. Approving starts a second run that makes exactly these and nothing else.</p>
      <div className="tp-plan"><Markdown text={run.proposed} /></div>
      <div className="tp-actions">
        <button className="btn btn-primary btn-sm" disabled={busy || answering} onClick={() => void approve()}><Icon name="check" size={13} /> Approve these changes</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onReply}><Icon name="reply" size={14} /> Reply</button>
        <span className="tp-hint">{answering ? `${name} is answering, and the plan may change.` : "Reply to ask about the plan or correct it. Nothing changes until you approve."}</span>
      </div>
    </section>
  );
}
