// Tidy tree layout for the org chart. Pure: members in, boxes and connector paths out.
//
// One stacking rule at every size: a manager's reports who have no reports of their own stack in one column beside
// their siblings (or straight under the manager when they are all there is), so the chart is a compact block that fits
// without zooming. A lone report with no reports of their own sits straight below. Lines are 1px, orthogonal, with
// rounded elbows.
import { YOU_ID } from "./org";

/** The geometry of one size of chart: card width, the gaps, and the spine gutter beside a stacked column. */
export type ChartMetrics = { w: number; gapX: number; gapY: number; stackGap: number; gutter: number; indent: number };

export const WIDE: ChartMetrics = { w: 248, gapX: 40, gapY: 48, stackGap: 12, gutter: 14, indent: 30 };
export const COMPACT: ChartMetrics = { w: 208, gapX: 28, gapY: 28, stackGap: 10, gutter: 12, indent: 26 };

/** Every node, you (YOU_ID) included. `parentId` null: the top of the company. `h`: the card's height. */
type LayoutInput = { id: string; parentId: string | null; h: number }[];
export type Box = { id: string; x: number; y: number; w: number; h: number; depth: number };
export type Edge = { id: string; from: string; to: string; d: string };
export type Layout = { boxes: Map<string, Box>; edges: Edge[]; width: number; height: number };

type Node = { id: string; h: number; children: Node[] };
type Pt = [number, number];
/** A laid-out subtree, relative to its own top-left. `attach` is where a line from above meets it. */
type Sub = { width: number; height: number; attach: number; boxes: Box[]; edges: { id: string; from: string; to: string; pts: Pt[] }[] };

const shift = (s: Sub, dx: number, dy: number): Sub => ({
  ...s,
  attach: s.attach + dx,
  boxes: s.boxes.map((b) => ({ ...b, x: b.x + dx, y: b.y + dy })),
  edges: s.edges.map((e) => ({ ...e, pts: e.pts.map(([x, y]) => [x + dx, y + dy] as Pt) })),
});

/** An orthogonal polyline as a path with rounded elbows. */
function rounded(pts: Pt[], r = 6): string {
  const clean = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  if (clean.length < 2) return "";
  let d = `M${clean[0][0]} ${clean[0][1]}`;
  for (let i = 1; i < clean.length - 1; i++) {
    const [a, b, c] = [clean[i - 1], clean[i], clean[i + 1]];
    const inLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const outLen = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const k = Math.min(r, inLen / 2, outLen / 2);
    const p1: Pt = [b[0] - Math.sign(b[0] - a[0]) * k, b[1] - Math.sign(b[1] - a[1]) * k];
    const p2: Pt = [b[0] + Math.sign(c[0] - b[0]) * k, b[1] + Math.sign(c[1] - b[1]) * k];
    d += ` L${p1[0]} ${p1[1]} Q${b[0]} ${b[1]} ${p2[0]} ${p2[1]}`;
  }
  const last = clean[clean.length - 1];
  return `${d} L${last[0]} ${last[1]}`;
}

/** `nest`: the denser form for an org wider than its window. A report who is a short stack (no reports, or only
 *  reports of their own who have none) goes in the stacked column beside the deeper ones, nested a step in, instead of
 *  side by side; a manager whose reports are all short stacks becomes one column. A big org then grows downward, which
 *  scrolls the way lists do, rather than sideways. */
export function layoutOrg(nodes: LayoutInput, m: ChartMetrics, { nest = false }: { nest?: boolean } = {}): Layout {
  const heights = new Map(nodes.map((n) => [n.id, n.h]));
  const ids = new Set([YOU_ID, ...nodes.map((n) => n.id)]);
  const parent = new Map<string, string | null>([[YOU_ID, null]]);
  for (const n of nodes) parent.set(n.id, n.parentId !== null && ids.has(n.parentId) && n.parentId !== n.id ? n.parentId : null);
  const topOf = (id: string): string | null => {
    const seen = new Set<string>();
    let cur = id;
    for (let p = parent.get(cur) ?? null; p !== null; p = parent.get(cur) ?? null) {
      if (seen.has(p)) return null;
      seen.add(p);
      cur = p;
    }
    return cur;
  };
  // One tree, rooted at the top of your line. Anything that can't reach it hangs off you.
  const root = topOf(YOU_ID) ?? YOU_ID;
  if (root === YOU_ID) parent.set(YOU_ID, null);
  for (const id of ids) if (id !== root && topOf(id) !== root) parent.set(id, YOU_ID);
  const byParent = new Map<string, string[]>();
  for (const n of [{ id: YOU_ID }, ...nodes]) {
    const p = parent.get(n.id) ?? null;
    if (p !== null && !(byParent.get(p) ?? []).includes(n.id)) byParent.set(p, [...(byParent.get(p) ?? []), n.id]);
  }
  const build = (id: string): Node => ({ id, h: heights.get(id) ?? 60, children: (byParent.get(id) ?? []).map(build) });

  // A column: `n` at (x0, y0), its reports stacked under it on a spine, each report's own reports a step further in.
  // Returns the column's bottom.
  const stack = (n: Node, depth: number, x0: number, y0: number, boxes: Box[], edges: Sub["edges"]): number => {
    boxes.push({ id: n.id, x: x0, y: y0, w: m.w, h: n.h, depth });
    if (!n.children.length) return y0 + n.h;
    const spine = x0 + m.indent - m.gutter;
    let y = y0 + n.h + m.stackGap + 4;
    for (const c of n.children) {
      const mid = y + Math.min(c.h / 2, 24);
      edges.push({ id: `${n.id}>${c.id}`, from: n.id, to: c.id, pts: [[spine, y0 + n.h], [spine, mid], [x0 + m.indent, mid]] });
      y = stack(c, depth + 1, x0 + m.indent, y, boxes, edges) + m.stackGap;
    }
    return y - m.stackGap;
  };
  const short = (c: Node) => c.children.every((g) => !g.children.length);

  const lay = (n: Node, depth: number): Sub => {
    const self: Box = { id: n.id, x: 0, y: 0, w: m.w, h: n.h, depth };
    if (!n.children.length) return { width: m.w, height: n.h, attach: m.w / 2, boxes: [self], edges: [] };
    if (nest && (n.children.length >= 2 || n.children.some((c) => c.children.length)) && n.children.every(short)) {
      const boxes: Box[] = [], edges: Sub["edges"] = [];
      const bottom = stack(n, depth, 0, 0, boxes, edges);
      const width = Math.max(...boxes.map((b) => b.x + b.w));
      return { width, height: bottom, attach: m.w / 2, boxes, edges };
    }

    const leaves = n.children.filter((c) => !c.children.length);
    const column = nest ? n.children.filter(short) : leaves.length >= 2 ? leaves : [];
    const row = n.children.filter((c) => !column.includes(c));
    const top = n.h + m.gapY;
    // The cards whose tops line up (the row, and the head of the stacked column) share one height, so their bottoms
    // and connectors line up too.
    if (row.length) {
      const level = [...row, ...column.slice(0, 1)];
      const h = Math.max(...level.map((c) => c.h));
      for (const c of level) c.h = h;
    }

    // Only reports with none of their own: they stack straight under the manager, hung from a spine.
    if (!row.length) {
      const spine = m.indent - m.gutter;
      const boxes = [self];
      const edges: Sub["edges"] = [];
      let y = n.h + m.stackGap + 4;
      for (const c of column) {
        boxes.push({ id: c.id, x: m.indent, y, w: m.w, h: c.h, depth: depth + 1 });
        const mid = y + Math.min(c.h / 2, 24);
        edges.push({ id: `${n.id}>${c.id}`, from: n.id, to: c.id, pts: [[spine, n.h], [spine, mid], [m.indent, mid]] });
        y += c.h + m.stackGap;
      }
      return { width: m.indent + m.w, height: y - m.stackGap, attach: m.w / 2, boxes, edges };
    }

    // A row of the reports with reports (and any lone leaf), then the stacked column of the rest.
    const items: { sub: Sub; attach: number; left: number }[] = [];
    let x = 0;
    for (const c of row) {
      const s = lay(c, depth + 1);
      items.push({ sub: s, attach: x + s.attach, left: x });
      x += s.width + m.gapX;
    }
    let colLeft = -1;
    if (column.length) {
      colLeft = x;
      x += m.gutter + Math.max(...column.map((c) => (c.children.length ? m.indent : 0) + m.w)) + m.gapX;
    }
    const rowRight = x - m.gapX;
    const first = items[0].attach;
    const last = column.length ? colLeft : items[items.length - 1].attach;
    const centre = (first + last) / 2;
    const selfLeft = centre - m.w / 2;
    const minX = Math.min(0, selfLeft);
    const dx = -minX;
    const width = Math.max(rowRight, selfLeft + m.w) - minX;
    const bus = n.h + m.gapY / 2;
    const px = centre + dx;

    const boxes: Box[] = [{ ...self, x: selfLeft + dx }];
    const edges: Sub["edges"] = [];
    let height = n.h;
    for (const it of items) {
      const s = shift(it.sub, it.left + dx, top);
      boxes.push(...s.boxes);
      edges.push(...s.edges);
      edges.push({ id: `${n.id}>${row[items.indexOf(it)].id}`, from: n.id, to: row[items.indexOf(it)].id, pts: [[px, n.h], [px, bus], [s.attach, bus], [s.attach, top]] });
      height = Math.max(height, top + s.height);
    }
    if (column.length) {
      const spine = colLeft + dx;
      let y = top;
      for (const c of column) {
        const mid = y + Math.min(c.h / 2, 24);
        edges.push({ id: `${n.id}>${c.id}`, from: n.id, to: c.id, pts: [[px, n.h], [px, bus], [spine, bus], [spine, mid], [spine + m.gutter, mid]] });
        y = stack(c, depth + 1, spine + m.gutter, y, boxes, edges) + m.stackGap;
      }
      height = Math.max(height, y - m.stackGap);
    }
    return { width, height, attach: px, boxes, edges };
  };

  const sub = lay(build(root), 0);
  return {
    boxes: new Map(sub.boxes.map((b) => [b.id, b])),
    edges: sub.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, d: rounded(e.pts) })),
    width: sub.width,
    height: sub.height,
  };
}

/** The members in tree order, each with its depth: the outline's rows. Same tree as `layoutOrg`. */
export function treeOrder(nodes: { id: string; parentId: string | null }[]): { id: string; depth: number; parentId: string | null }[] {
  const ids = new Set([YOU_ID, ...nodes.map((n) => n.id)]);
  const parent = new Map<string, string | null>([[YOU_ID, null]]);
  for (const n of nodes) parent.set(n.id, n.parentId !== null && ids.has(n.parentId) && n.parentId !== n.id ? n.parentId : null);
  const topOf = (id: string): string | null => {
    const seen = new Set<string>();
    let cur = id;
    for (let p = parent.get(cur) ?? null; p !== null; p = parent.get(cur) ?? null) {
      if (seen.has(p)) return null;
      seen.add(p);
      cur = p;
    }
    return cur;
  };
  const root = topOf(YOU_ID) ?? YOU_ID;
  if (root === YOU_ID) parent.set(YOU_ID, null);
  for (const id of ids) if (id !== root && topOf(id) !== root) parent.set(id, YOU_ID);
  const kids = new Map<string, string[]>();
  for (const n of [{ id: YOU_ID }, ...nodes]) {
    const p = parent.get(n.id) ?? null;
    if (p !== null && !(kids.get(p) ?? []).includes(n.id)) kids.set(p, [...(kids.get(p) ?? []), n.id]);
  }
  const out: { id: string; depth: number; parentId: string | null }[] = [];
  const walk = (id: string, depth: number) => {
    out.push({ id, depth, parentId: parent.get(id) ?? null });
    for (const c of kids.get(id) ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}
