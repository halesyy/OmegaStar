import { useLayoutEffect, useMemo, useRef } from "react";
import type { Company, EmployeeView, PersonView } from "../api/types";
import { YOU_ID } from "../lib/org";
import { treeOrder } from "../lib/orgLayout";
import { useScrollFade } from "../lib/scrollFade";
import { NameParts, employeeState, liveLines, personLine, textWidth, visibleMembers, type OrgView, type StateTone } from "./OrgChart";
import { Avatar } from "./ui";

// Row geometry: the tree lines are drawn from it, so it is fixed (OrgChart.css keeps the same numbers).
// `room`: the width a row's words have at depth 0 (the column, less the row's insets, avatar and gap); each level of
// depth takes one indent from it.
const ROW = { wide: { h: 44, indent: 22, pad: 16, av: 28, room: 215 }, compact: { h: 40, indent: 20, pad: 12, av: 22, room: 124 } };

type Row = { id: string; depth: number; parentId: string | null; name: string; hue: number; image?: string | null; kind: "you" | "employee" | "person";
  line: { kind: "state" | "role"; tone: StateTone | "warn" | null; text: string } | null; presence: EmployeeView["presence"] | undefined;
  /** The name is set as the first name alone: the full one does not fit at this depth. */
  short: boolean };

/**
 * The chart folded into a list: the same people in the same tree, each a row with their state or their role on the
 * second line, never both. The open person is the inverted row. Up and Down move through it, Enter opens.
 */
export function OrgOutline({ company, employees, people, view, selectedId, compact, onOpen }: {
  company: Company; employees: EmployeeView[]; people: PersonView[]; view: OrgView; selectedId: string | null; compact: boolean;
  onOpen: (id: string) => void;
}) {
  const g = compact ? ROW.compact : ROW.wide;
  const rows: Row[] = useMemo(() => {
    const org = { company, employees, people };
    const raw = treeOrder(visibleMembers(org, view)).map(({ id, depth, parentId }): Omit<Row, "short"> & { line: NonNullable<Row["line"]> } => {
      if (id === YOU_ID) {
        return { id, depth, parentId, name: company.ceoName, hue: 0, image: company.image, kind: "you", presence: undefined, line: { kind: "role", tone: null, text: `${company.title}, you` } };
      }
      const e = employees.find((x) => x.id === id);
      if (e) {
        const s = employeeState(e, employees, people);
        const busy = s.tone !== "plain";
        return { id, depth, parentId, name: e.name, hue: e.hue, image: e.image, kind: "employee", presence: e.presence,
          line: busy ? { kind: "state", tone: s.tone, text: s.word } : { kind: "role", tone: null, text: e.title } };
      }
      const p = people.find((x) => x.id === id);
      const pl = p ? personLine(p) : { waiting: false, text: "" };
      return { id, depth, parentId, name: p?.name ?? "", hue: p?.hue ?? 0, image: p?.image, kind: "person", presence: undefined,
        line: pl.waiting ? { kind: "state", tone: "warn", text: pl.text } : { kind: "role", tone: null, text: p?.title ?? "" } };
    });
    // Nothing in a row is cut, and each level reads alike: where any name at a depth would not fit, that whole level
    // shows first names; where any role would not fit, that whole level leaves roles out (they are on each page and the
    // chart). A state is a word or two and always shows.
    const levels = new Map<number, { names: boolean; roles: boolean }>();
    for (const r of raw) {
      const room = g.room - r.depth * g.indent;
      const l = levels.get(r.depth) ?? { names: true, roles: true };
      if (textWidth(r.name, 600, 13.5) > room) l.names = false;
      if (r.line.kind === "role" && textWidth(r.line.text, 400, 12) > room) l.roles = false;
      levels.set(r.depth, l);
    }
    return raw.map((r) => {
      const l = levels.get(r.depth) as { names: boolean; roles: boolean };
      return { ...r, line: r.line.kind === "role" && !l.roles ? null : r.line, short: compact || !l.names };
    });
  }, [company, employees, people, view, compact, g]);
  const lit = useMemo(() => liveLines(employees), [employees]);

  // The tree's lines, from each parent's avatar down and across to each child's: 1px with a rounded elbow.
  const index = new Map(rows.map((r, i) => [r.id, i]));
  const cx = (depth: number) => g.pad + depth * g.indent + g.av / 2;
  const cy = (i: number) => i * g.h + g.h / 2;
  const lines = rows.flatMap((r, i) => {
    const pi = r.parentId === null ? undefined : index.get(r.parentId);
    if (pi === undefined) return [];
    // Every elbow has the same 6px radius, the live line's included: the stub to the avatar is long enough to hold it.
    const x = cx(rows[pi].depth), y0 = cy(pi) + g.av / 2 + 3, y1 = cy(i), x1 = cx(r.depth) - g.av / 2 - 3;
    const k = Math.min(6, (y1 - y0) / 2, x1 - x);
    return [{ id: `${r.parentId}>${r.id}`, d: `M${x} ${y0} L${x} ${y1 - k} Q${x} ${y1} ${x + k} ${y1} L${x1} ${y1}` }];
  });

  const scroll = useScrollFade<HTMLDivElement>();
  const list = useRef<HTMLDivElement>(null);
  // The open person's row in view: the outline scrolls itself only (never the page around it), centring a row that
  // was out of sight.
  useLayoutEffect(() => {
    const box = scroll.current;
    const row = selectedId ? list.current?.querySelector<HTMLElement>(`[data-member="${selectedId}"]`) : null;
    if (!box || !row) return;
    const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    // Centred, then snapped so the top edge falls on a whole row: no row is sliced by the head's rule.
    if (top < box.scrollTop + 8 || top + row.offsetHeight > box.scrollTop + box.clientHeight - 24) {
      const pad = parseFloat(getComputedStyle(box).paddingTop) || 0;
      const want = top - (box.clientHeight - row.offsetHeight) / 2;
      // A few pixels above a row's top: the gap between rows sits under the edge's short fade, never a row's words. Near
      // the end of the list it rounds down, so the top edge is still whole and the cut, if any, is at the foot.
      const max = box.scrollHeight - box.clientHeight;
      const at = Math.min(want, max);
      box.scrollTop = Math.max(0, pad + (at >= max ? Math.floor((at - pad + 4) / g.h) : Math.round((at - pad) / g.h)) * g.h - 4);
    }
  }, [selectedId, scroll, g.h]);

  const move = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const btns = [...(list.current?.querySelectorAll<HTMLButtonElement>(".orow") ?? [])];
    if (!btns.length) return;
    e.preventDefault();
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1 : Math.max(0, Math.min(btns.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
    btns[to].focus();
  };
  const tabStop = selectedId && index.has(selectedId) ? selectedId : rows[0]?.id;

  return (
    <div className="ol-scroll scroll-fade" ref={scroll} data-fold="tree">
      <div className="ol-tree" ref={list} role="list" aria-label="Everyone" onKeyDown={move} style={{ height: rows.length * g.h }}>
        <svg className="ol-lines" width="100%" height={rows.length * g.h} aria-hidden data-fold="lines">
          {lines.filter((l) => !lit.has(l.id)).map((l) => <path key={l.id} d={l.d} />)}
          {lines.filter((l) => lit.has(l.id)).map((l) => <path key={l.id} d={l.d} className="ol-line-live" />)}
        </svg>
        {rows.map((r) => {
          const on = r.id === selectedId;
          return (
            <div key={r.id} role="listitem" className="ol-item" style={{ paddingLeft: g.pad + r.depth * g.indent - 6 }}>
              <button
                type="button" className={`orow ${on ? "orow-on" : ""}`} data-member={r.id} aria-current={on ? "page" : undefined}
                tabIndex={r.id === tabStop ? 0 : -1} onClick={() => onOpen(r.id)}
                aria-label={`${r.name}${r.line ? `. ${r.line.text}` : ""}`} data-tip={r.short || !r.line ? [r.name, r.line?.text].filter(Boolean).join(", ") : undefined}
              >
                <span className="orow-av" data-part="av">
                  <Avatar name={r.name} hue={r.hue} image={r.image} size={g.av} you={r.kind === "you"} person={r.kind === "person"} presence={compact ? r.presence : undefined} />
                </span>
                <span className="orow-text">
                  <span className={`orow-name ${r.short ? "orow-first" : ""}`} data-part="name"><NameParts name={r.name} /></span>
                  {compact || !r.line ? null : <span className={`orow-line ${r.line.tone ? `orow-${r.line.tone}` : ""}`} data-part="line" data-kind={r.line.kind}>{r.line.text}</span>}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
