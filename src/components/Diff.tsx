import { useMemo, useState, type ReactNode } from "react";
import { diffLines, diffWordsWithSpace } from "diff";
import "./Diff.css";

type Line = { kind: "same" | "add" | "del"; text: string; a: number | null; b: number | null; words?: ReactNode };
type Block = { kind: "lines"; lines: Line[] } | { kind: "fold"; lines: Line[] };

function splitLines(s: string): string[] {
  const parts = s.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function lineStats(before: string | null, after: string | null): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const c of diffLines(before ?? "", after ?? "")) {
    const n = c.count ?? splitLines(c.value).length;
    if (c.added) added += n;
    else if (c.removed) removed += n;
  }
  return { added, removed };
}

function inline(a: string, b: string): { del: ReactNode; add: ReactNode } {
  const parts = diffWordsWithSpace(a, b);
  const del: ReactNode[] = [];
  const add: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (p.added) add.push(<mark key={i}>{p.value}</mark>);
    else if (p.removed) del.push(<mark key={i}>{p.value}</mark>);
    else { add.push(p.value); del.push(p.value); }
  });
  return { del, add };
}

function build(before: string, after: string): Line[] {
  const out: Line[] = [];
  let a = 1, b = 1;
  const changes = diffLines(before, after);
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const lines = splitLines(c.value);
    if (c.removed && changes[i + 1]?.added) {
      const added = splitLines(changes[i + 1].value);
      const pairs = Math.min(lines.length, added.length);
      const dels: Line[] = [], adds: Line[] = [];
      lines.forEach((t, j) => {
        const w = j < pairs ? inline(t, added[j]) : null;
        dels.push({ kind: "del", text: t, a: a++, b: null, words: w?.del });
      });
      added.forEach((t, j) => {
        const w = j < pairs ? inline(lines[j], t) : null;
        adds.push({ kind: "add", text: t, a: null, b: b++, words: w?.add });
      });
      out.push(...dels, ...adds);
      i++;
      continue;
    }
    for (const t of lines) {
      if (c.added) out.push({ kind: "add", text: t, a: null, b: b++ });
      else if (c.removed) out.push({ kind: "del", text: t, a: a++, b: null });
      else out.push({ kind: "same", text: t, a: a++, b: b++ });
    }
  }
  return out;
}

function fold(lines: Line[], context = 3): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "same") {
      const start = i;
      while (i < lines.length && lines[i].kind !== "same") i++;
      blocks.push({ kind: "lines", lines: lines.slice(start, i) });
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i].kind === "same") i++;
    const run = lines.slice(start, i);
    const head = start === 0 ? 0 : context;
    const tail = i === lines.length ? 0 : context;
    if (run.length > head + tail + 2) {
      if (head) blocks.push({ kind: "lines", lines: run.slice(0, head) });
      blocks.push({ kind: "fold", lines: run.slice(head, run.length - tail) });
      if (tail) blocks.push({ kind: "lines", lines: run.slice(run.length - tail) });
    } else blocks.push({ kind: "lines", lines: run });
  }
  return blocks;
}

export function Diff({ before, after }: { before: string | null; after: string | null }) {
  const blocks = useMemo(() => fold(build(before ?? "", after ?? "")), [before, after]);
  const [open, setOpen] = useState(new Set<number>());
  return (
    <div className="diff mono" role="table" aria-label="Changes">
      {blocks.map((blk, i) =>
        blk.kind === "fold" && !open.has(i) ? (
          <button key={i} className="diff-fold" onClick={() => setOpen(new Set(open).add(i))}>
            ⋯ {blk.lines.length} unchanged lines
          </button>
        ) : (
          blk.lines.map((l, j) => (
            <div key={`${i}-${j}`} className={`diff-line diff-${l.kind}`} role="row">
              <span className="diff-no">{l.a ?? ""}</span>
              <span className="diff-no">{l.b ?? ""}</span>
              <span className="diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
              <span className="diff-text">{l.words ?? (l.text || " ")}</span>
            </div>
          ))
        ),
      )}
    </div>
  );
}
