import { useEffect, useState } from "react";
import type { SkillScan } from "../../lib/hooks";
import { plural } from "../../lib/format";
import { Row, SaveButton, sentence, useRowSave } from "./rows";

export function SkillsDesc({ scan }: { scan: SkillScan }) {
  const src = scan.sources;
  if (!src) return scan.error ? <span className="set-err">{sentence(scan.error)}</span> : <>Looking for your Claude Code skills…</>;
  const note = src.unreadable > 0 ? `${plural(src.unreadable, "skill")} couldn't be read.` : null;
  return (
    <>
      <span className="mono">{src.skillsDir}</span>
      {note ? <span className="set-note">{note}</span> : null}
      {src.error && (src.found === 0 || src.unreadable > 0) ? <span className="set-note mono">{src.error}</span> : null}
    </>
  );
}

/** The Claude Code path: Save reports on the button; a failed save is the row's line with Try again, like every other
 *  row. `confirmed` is what the app last saved, so a failed save keeps what you typed. */
export function PathRow({ confirmed, onEdit, onSave }: { confirmed: string; onEdit: () => void; onSave: (path: string) => void }) {
  const [draft, setDraft] = useState(confirmed);
  useEffect(() => { setDraft(confirmed); }, [confirmed]);
  const save = useRowSave("Path override");
  const failed = save?.state === "failed";
  const changed = draft.trim() !== confirmed;
  return (
    <Row title="Path override" desc="Leave empty to find Claude Code automatically." mark={false}>
      <form className="set-field-row" onSubmit={(e) => { e.preventDefault(); if (changed) onSave(draft.trim()); }}>
        <input
          className="input mono set-input" value={draft} placeholder="Automatic" aria-label="Claude Code path"
          onChange={(e) => { setDraft(e.target.value); if (failed) onEdit(); }}
        />
        <SaveButton state={failed ? undefined : save?.state} disabled={!changed} />
      </form>
    </Row>
  );
}
