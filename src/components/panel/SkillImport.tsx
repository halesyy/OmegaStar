import { useEffect, useState } from "react";
import { call, errorMessage } from "../../api/client";
import type { EmployeeView, OriginalSkill, Run } from "../../api/types";
import { firstName } from "../../lib/format";
import { refreshOrg, useCatalog } from "../../lib/hooks";
import { toast } from "../../lib/toasts";
import { Icon } from "../Icon";
import { SkillPicker } from "../SkillPicker";
import { ErrorNote, Skeleton, SlideOver } from "../ui";

export type OrganizeRun = Run & { kind: Extract<Run["kind"], { type: "organize" }> };
export const isOrganize = (r: Run): r is OrganizeRun => r.kind.type === "organize";

export function ImportSheet({ e, preselect, onClose }: { e: EmployeeView; preselect: string[] | null; onClose: () => void }) {
  const catalog = useCatalog();
  const [keys, setKeys] = useState(preselect ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = preselect !== null;
  const name = firstName(e.name);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await call("import_skills", { employeeId: e.id, skillIds: keys });
      refreshOrg();
      onClose();
      toast(`Copied ${keys.length} ${keys.length === 1 ? "skill" : "skills"} to ${name}. ${name} is organizing them now.`, "ok");
    } catch (x) {
      setErr(errorMessage(x));
      setBusy(false);
    }
  };
  return (
    <SlideOver open={open} onClose={onClose} width={620} label={`Import skills into ${name}'s family`} modal>
      <header className="sheet-head">
        <div className="stack">
          <h2 className="h-lg">Import skills</h2>
          <p className="muted">{name} gets their own copy of each skill, then organizes them into one family: grouped, merged where they overlap, and written the way {name} writes skills.</p>
        </div>
        <button className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="sheet-body import-body">
        <div className="stack" style={{ gap: 12 }}>
          <SkillPicker mode="import" catalog={catalog.data} keys={keys} builtins={false} onChange={(v) => setKeys(v.keys)} />
          <ul className="import-notes">
            <li>Your originals in Claude Code aren't touched. Afterwards {name}'s copies change and improve on their own, not connected to yours.</li>
            <li>Anything imported that was granted to {name} as a tool stops being granted, so {name} never loads two versions.</li>
            <li>The whole reorganization is one entry under Changes, and you can undo it.</li>
          </ul>
        </div>
      </div>
      <footer className="sheet-foot">
        {err ? <ErrorNote text={err} /> : <span className="faint">{name} starts organizing as soon as they land.</span>}
        <span className="grow" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || keys.length === 0} onClick={() => void submit()}>
          {busy ? "Importing…" : keys.length ? `Import ${keys.length} ${keys.length === 1 ? "skill" : "skills"}` : "Import"}
        </button>
      </footer>
    </SlideOver>
  );
}

export function OriginalsSheet({ e, run, onClose }: { e: EmployeeView; run: OrganizeRun | null; onClose: () => void }) {
  const [list, setList] = useState<OriginalSkill[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = firstName(e.name);
  useEffect(() => {
    if (!run) return;
    setList(null); setPicked([]); setErr(null); setBusy(false);
    call("import_originals", { runId: run.id }).then(setList, (x) => setErr(errorMessage(x)));
  }, [run]);
  const finish = async (names: string[]) => {
    if (!run) return;
    setBusy(true);
    setErr(null);
    try {
      if (names.length) {
        const removed = await call("remove_originals", { runId: run.id, names });
        toast(`Moved ${removed.length} ${removed.length === 1 ? "skill" : "skills"} to the Recycle Bin. ${name} keeps their own copies.`, "ok");
      } else {
        await call("settle_originals", { runId: run.id });
        toast("Kept your skills. They and " + name + "'s copies now evolve separately.", "neutral");
      }
      refreshOrg();
      onClose();
    } catch (x) {
      setErr(errorMessage(x));
      setBusy(false);
    }
  };
  const toggle = (n: string) => setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));
  return (
    <SlideOver open={run !== null} onClose={onClose} width={560} label="Your original skills" modal>
      <header className="sheet-head">
        <div className="stack">
          <h2 className="h-lg">{name} now has their own copies of these skills</h2>
          <p className="muted">
            {name} will manage, change and improve them. They aren't connected to your originals: nothing {name} changes reaches yours, and nothing you change reaches theirs.
            Your originals stay in Claude Code, unchanged. If you no longer need them, you can remove them here.
          </p>
        </div>
        <button className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="sheet-body import-body">
        {!list && !err ? <div className="stack" style={{ gap: 8 }}><Skeleton /><Skeleton w="80%" /><Skeleton w="60%" /></div> : null}
        {list ? (
          <div className="sp originals">
            {list.map((o) => {
              const on = picked.includes(o.name);
              return (
                <label key={o.id} className={`sp-row ${on ? "sp-row-on" : ""} ${o.removable ? "" : "originals-off"}`}>
                  <input type="checkbox" checked={on} disabled={!o.removable} onChange={() => toggle(o.name)} />
                  <span className="sp-check" aria-hidden><Icon name="check" size={11} strokeWidth={2} /></span>
                  <span className="stack grow" style={{ minWidth: 0 }}>
                    <span className="sp-name mono">{o.name}</span>
                    {!o.present ? <span className="sp-desc">Already gone from your Claude Code skills.</span> : null}
                    {o.notes.map((n) => <span key={n} className="originals-note"><Icon name="alert" size={11} /> {n}</span>)}
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}
        <p className="faint" style={{ fontSize: "var(--t-sm)", marginTop: 10 }}>Removed skills go to the Recycle Bin, so you can restore them from there.</p>
      </div>
      <footer className="sheet-foot">
        {err ? <ErrorNote text={err} /> : <span className="faint">{picked.length ? `${picked.length} selected` : "Nothing is removed unless you tick it."}</span>}
        <span className="grow" />
        <button className="btn btn-ghost" disabled={busy || picked.length === 0} onClick={() => void finish(picked)}>Remove selected</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void finish([])}>Keep my skills</button>
      </footer>
    </SlideOver>
  );
}
