import { useState } from "react";
import { call, errorMessage } from "../api/client";
import type { EmployeeView, Run } from "../api/types";
import { firstName } from "../lib/format";
import { toast } from "../lib/toasts";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import "./TidyProposal.css";

/**
 * The bigger changes a tidy wants to make: splitting, merging, renaming or retiring a skill, or
 * changing a rule you taught. It only proposes them; approving starts a second run that makes exactly these.
 */
export function TidyProposal({ run, employee }: { run: Run; employee: EmployeeView | undefined }) {
  const [busy, setBusy] = useState(false);
  // Asking about it decides nothing. An archived one waits until you reopen it, so one an older build approved stays approved.
  if (run.kind.type !== "tidy" || !run.proposed || run.approvedAt || run.archivedAt) return null;
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
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void approve()}><Icon name="check" size={13} /> Approve these changes</button>
        <span className="tp-hint">A reply leaves the plan as it is.</span>
      </div>
    </section>
  );
}
