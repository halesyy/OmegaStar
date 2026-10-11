// Tidy tree layout for the org chart. Pure: members in, boxes, connector paths and ports out.
import { YOU_ID } from "./org";

export const CARD_W = 236;
export const CARD_H = 76;
const GAP_X = 16;
const GAP_Y = 56;
const STACK_INDENT = 32;
const STACK_GAP = 14;

/** Every node, you (YOU_ID) included. `parentId` null: the top of the company. */
type LayoutInput = { id: string; parentId: string | null }[];
type Box = { id: string; x: number; y: number; w: number; h: number; depth: number };
type Edge = { id: string; d: string };
type Port = { id: string; x: number; y: number };
type Layout = { boxes: Map<string, Box>; edges: Edge[]; ports: Port[]; width: number; height: number };

type Node = { id: string; children: Node[]; w: number; h: number; stacked: boolean; span: number };

/** `stackMin`: a manager whose reports are all leaves stacks them vertically once there are at least this many. */
export function layoutOrg(nodes: LayoutInput, stackMin = 3): Layout {
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
  for (const id of ids) {
    const p = parent.get(id) ?? null;
    if (p !== null) byParent.set(p, [...(byParent.get(p) ?? []), id]);
  }

  const build = (id: string): Node => {
    const kids = (byParent.get(id) ?? []).map(build);
    const stacked = id !== YOU_ID && kids.length >= stackMin && kids.every((k) => k.children.length === 0);
    let span = CARD_W;
    if (kids.length > 0) {
      span = stacked ? STACK_INDENT + CARD_W : Math.max(CARD_W, kids.reduce((s, k) => s + k.span, 0) + GAP_X * (kids.length - 1));
    }
    return { id, children: kids, w: CARD_W, h: CARD_H, stacked, span };
  };
  const top = build(root);

  const boxes = new Map<string, Box>();
  const edges: Edge[] = [];
  const ports: Port[] = [];
  let maxY = 0;

  const place = (n: Node, left: number, top: number, depth: number) => {
    const x = left + (n.span - (n.stacked ? STACK_INDENT + CARD_W : n.w)) / 2;
    boxes.set(n.id, { id: n.id, x, y: top, w: n.w, h: n.h, depth });
    maxY = Math.max(maxY, top + n.h);
    if (n.children.length === 0) return;
    const bottom = top + n.h;

    if (n.stacked) {
      const tx = x + 18;
      ports.push({ id: `${n.id}:out`, x: tx, y: bottom });
      let y = bottom + STACK_GAP;
      for (const c of n.children) {
        const cx = x + STACK_INDENT;
        place(c, cx, y, depth + 1);
        const cy = y + c.h / 2;
        edges.push({ id: `${n.id}>${c.id}`, d: `M${tx} ${bottom} C${tx} ${cy} ${tx} ${cy} ${cx} ${cy}` });
        ports.push({ id: `${c.id}:in`, x: cx, y: cy });
        y += c.h + STACK_GAP;
      }
      return;
    }

    const childTop = bottom + GAP_Y;
    const px = x + n.w / 2;
    const midY = bottom + GAP_Y / 2;
    ports.push({ id: `${n.id}:out`, x: px, y: bottom });
    const used = n.children.reduce((s, k) => s + k.span, 0) + GAP_X * (n.children.length - 1);
    let cl = left + (n.span - used) / 2;
    for (const c of n.children) {
      place(c, cl, childTop, depth + 1);
      const cb = boxes.get(c.id);
      if (cb) {
        const cx = cb.x + cb.w / 2;
        edges.push({ id: `${n.id}>${c.id}`, d: `M${px} ${bottom} C${px} ${midY} ${cx} ${midY} ${cx} ${childTop}` });
        ports.push({ id: `${c.id}:in`, x: cx, y: childTop });
      }
      cl += c.span + GAP_X;
    }
  };
  place(top, 0, 0, 0);

  return { boxes, edges, ports, width: top.span, height: maxY };
}
