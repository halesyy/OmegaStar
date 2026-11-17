import { useMemo, useState } from "react";
import type { SkillInfo, SkillSource } from "../api/types";
import { rescanSkills, useSkillScan } from "../lib/hooks";
import { Icon } from "./Icon";
import { ErrorNote, Skeleton, Switch } from "./ui";
import "./SkillPicker.css";

const GROUPS: { source: SkillSource; label: string }[] = [
  { source: "user", label: "Yours" },
  { source: "synced", label: "claude.ai" },
  { source: "plugin", label: "Plugins" },
];

/** Rows shown before "Show all": the list renders inline (no inner scroll), so a long catalog is capped. */
const COLLAPSED_ROWS = 6;

/**
 * `keys` are the ticked skills. With `imports`, each ticked skill of yours or from claude.ai can be
 * a tool (granted) or imported (copied in as their own); `imports` is the imported subset of `keys`.
 * `mode="import"` lists only importable skills and every ticked one is imported.
 */
export function SkillPicker({ catalog, keys, builtins, onChange, imports, onImportsChange, mode = "grant" }: {
  catalog: SkillInfo[] | undefined; keys: string[]; builtins: boolean;
  onChange: (next: { keys: string[]; builtins: boolean }) => void;
  imports?: string[]; onImportsChange?: (ids: string[]) => void; mode?: "grant" | "import";
}) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const scan = useSkillScan();
  const sources = scan.sources;
  const selected = useMemo(() => new Set(keys), [keys]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!catalog) return [];
    return catalog.filter((s) => mode === "grant" || s.source !== "plugin").filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle) || (s.skills ?? []).some((x) => x.includes(needle)));
  }, [catalog, q, mode]);

  const capped = !all && !q.trim() && filtered.length > COLLAPSED_ROWS + 1;
  const shown = useMemo(() => {
    const ordered = GROUPS.flatMap((g) => filtered.filter((s) => s.source === g.source));
    if (!capped) return new Set(ordered.map((s) => s.id));
    // Granted skills stay visible even when they fall below the cap.
    return new Set([...ordered.slice(0, COLLAPSED_ROWS).map((s) => s.id), ...keys]);
  }, [filtered, capped, keys]);

  const importing = useMemo(() => new Set(imports ?? []), [imports]);
  const toggle = (id: string) => {
    const on = selected.has(id);
    const next = on ? keys.filter((k) => k !== id) : [...keys, id];
    onChange({ keys: next, builtins });
    if (on && importing.has(id)) onImportsChange?.((imports ?? []).filter((k) => k !== id));
  };
  const setImported = (id: string, yes: boolean) => {
    const rest = (imports ?? []).filter((k) => k !== id);
    onImportsChange?.(yes ? [...rest, id] : rest);
  };
  const imported = keys.filter((k) => importing.has(k)).length;

  return (
    <div className="sp">
      <div className="sp-top">
        <div className="input-affix grow">
          <span className="affix"><Icon name="search" size={13} /></span>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your skills" aria-label="Search skills" />
        </div>
        <span className="sp-count num">
          {mode === "import" ? `${keys.length} to import` : imported ? `${keys.length - imported} tools · ${imported} imported` : `${keys.length} selected`}
        </span>
      </div>
      <div className={`sp-list ${capped ? "sp-list-capped" : ""}`}>
        {!catalog ? (
          scan.error ? <div style={{ padding: 12 }}><ErrorNote text={scan.error} onRetry={rescanSkills} /></div>
            : <div className="stack" style={{ gap: 10, padding: 12 }}><Skeleton /><Skeleton w="80%" /><Skeleton w="60%" /></div>
        ) : null}
        {catalog && catalog.length === 0 && !q.trim() ? (
          <div className="empty sp-none">
            <Icon name="layers" size={22} />
            <span className="empty-title">No skills found</span>
            <p>OmegaStar looked in <span className="mono">{sources?.skillsDir ?? "your Claude Code skills folder"}</span>.</p>
            {sources?.error ? <p className="sp-none-err mono">{sources.error}</p> : null}
            <button type="button" className="btn btn-sm" onClick={rescanSkills} disabled={scan.scanning}>
              <Icon name="refresh" size={12} /> {scan.scanning ? "Scanning…" : "Rescan"}
            </button>
          </div>
        ) : null}
        {catalog && filtered.length === 0 && q.trim() ? <div className="sp-empty">No skills match “{q.trim()}”.</div> : null}
        {GROUPS.map((g) => {
          const items = filtered.filter((s) => s.source === g.source && shown.has(s.id));
          if (items.length === 0) return null;
          return (
            <div key={g.source} className="sp-group">
              <div className="sp-group-label">{g.label}</div>
              {items.map((s) => {
                const on = selected.has(s.id);
                return (
                  <label key={s.id} className={`sp-row ${on ? "sp-row-on" : ""}`}>
                    <input type="checkbox" checked={on} onChange={() => toggle(s.id)} />
                    <span className="sp-check" aria-hidden><Icon name="check" size={11} strokeWidth={2} /></span>
                    <span className="stack grow" style={{ minWidth: 0 }}>
                      <span className="sp-name">{s.name}{s.source === "plugin" && s.skills ? <span className="sp-sub"> · {s.skills.length} skills</span> : null}</span>
                      <span className="sp-desc">{s.description}</span>
                      {s.source === "plugin" && s.skills ? <span className="sp-plugin-skills mono">{s.skills.join("  ")}</span> : null}
                    </span>
                    {on && onImportsChange && mode === "grant" && s.source !== "plugin" ? (
                      <span className="seg sp-mode" role="group" aria-label={`How ${s.name} is used`}>
                        <button type="button" aria-pressed={!importing.has(s.id)} title="Granted: they call your skill by name"
                          onClick={(ev) => { ev.preventDefault(); setImported(s.id, false); }}>Tool</button>
                        <button type="button" aria-pressed={importing.has(s.id)} title="Copied into their skills, then organized as their own"
                          onClick={(ev) => { ev.preventDefault(); setImported(s.id, true); }}>Import</button>
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>
      {capped ? (
        <button type="button" className="sp-more" onClick={() => setAll(true)}>
          Show all {filtered.length} skills <Icon name="chevronDown" size={12} />
        </button>
      ) : null}
      {catalog && catalog.length > 0 && sources && sources.unreadable > 0 ? (
        <div className="sp-warn" title={sources.error ?? undefined}>
          <Icon name="alert" size={12} />
          <span className="grow">{sources.unreadable === 1 ? "1 skill couldn't be read." : `${sources.unreadable} skills couldn't be read.`}</span>
          <button type="button" className="sp-link" onClick={rescanSkills} disabled={scan.scanning}>{scan.scanning ? "Scanning…" : "Rescan"}</button>
        </div>
      ) : null}
      {mode === "import" ? null : <div className="sp-builtins">
        <span className="stack grow">
          <span className="sp-name">Claude Code built-ins</span>
          <span className="sp-desc">Skills that ship with Claude Code itself, such as <span className="mono">loop</span>, <span className="mono">schedule</span> and <span className="mono">code-review</span>. Off unless this role needs them.</span>
        </span>
        <Switch checked={builtins} onChange={(v) => onChange({ keys, builtins: v })} label="Claude Code built-ins" />
      </div>}
      <p className="sp-foot">
        {mode === "import"
          ? "Imported skills are copied in. Your originals stay in Claude Code, unchanged and no longer connected."
          : onImportsChange
            ? "Tool: they call your skill by name. Import: they get their own copy and organize it into their skills. Unticked skills are invisible to them."
            : "Skills you leave unticked are invisible to this employee."}
      </p>
    </div>
  );
}
