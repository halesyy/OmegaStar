// Opening a person: the chart folds into the outline while their page rides the outline's edge in from the window's
// edge. Each card on screen sheds its extra lines first, then gathers into its row's size (so cards in flight stay small)
// and glides to its row, opaque all the way. Cards nearest the outline leave first and those further right a beat later,
// so a row never runs through another on its way. The page is drawn over the travelling rows: only its leading edge
// ever crosses them. The line the outline keeps (their state, else their role) travels with the row, moving only once
// the lines it would cross have gone. The chart's lines go in the first 20%, the outline's draw in over the last 40%,
// and the open person's fill arrives in the last 20%. Closing plays the same move backwards from wherever it is.
// Under reduced motion nothing travels: the chart fades out, then the outline and page fade in, never both at once.
//
// The page renders both views while the fold runs: `[data-view="chart"]` (cards are `[data-member]` inside
// `[data-fold="canvas"]`) and `[data-view="outline"]` (rows are `.orow[data-member]` inside `[data-fold="tree"]`), plus
// `[data-view="page"]` and an empty `[data-fold="layer"]` for the travelling copies. Parts carry `data-part`.
import { curve, ms, reducedMotion } from "../lib/motion";

export type FoldTarget = "open" | "chart";
export type Fold = {
  /** Steer the running fold: it turns round from the frame it is on if the target changed. */
  toward: (t: FoldTarget) => void;
  /** Called once when the fold lands, with where it landed. */
  onLand: (cb: (t: FoldTarget) => void) => void;
  /** Remove every trace once the landed view has rendered. */
  cleanup: () => void;
};

type R = { x: number; y: number; w: number; h: number };
const rel = (el: Element, host: DOMRect): R => {
  const a = el.getBoundingClientRect();
  return { x: a.left - host.left, y: a.top - host.top, w: a.width, h: a.height };
};
const shown = (el: Element | null): el is HTMLElement => !!el && el instanceof HTMLElement && el.getClientRects().length > 0;
const inside = (r: R, box: R) => r.x + r.w > box.x && r.x < box.x + box.w && r.y + r.h > box.y && r.y < box.y + box.h;
const fullyInside = (r: R, box: R) => r.y >= box.y - 1 && r.y + r.h <= box.y + box.h + 1;

/** Builds the fold between the two rendered views and starts it toward `target`. */
export function startFold(root: HTMLElement, target: FoldTarget, selectedId: string | null): Fold {
  const host = root.getBoundingClientRect();
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T & Element>(sel);
  const chart = q('[data-view="chart"]');
  const outline = q('[data-view="outline"]');
  const page = q('[data-view="page"]');
  const layer = q('[data-fold="layer"]');
  const anims: Animation[] = [];
  let landed: ((t: FoldTarget) => void) | null = null;
  let current = target;

  // SPREAD: how much later the furthest card from the outline leaves than the nearest.
  const D = ms("--d-fold"), F = ms("--d-fade"), STAG = 8, SPREAD = 120;
  const move = curve("--ease-move"), snap = curve("--ease");
  const add = (el: Element, kf: Keyframe[], o: KeyframeAnimationOptions = {}) => {
    anims.push(el.animate(kf, { duration: D, easing: move, fill: "both", ...o }));
  };
  const lin: KeyframeAnimationOptions = { easing: "linear" };
  const fadeOut = (until = 0.25): Keyframe[] => [{ opacity: 1, offset: 0 }, { opacity: 0, offset: until }, { opacity: 0 }];
  const fadeIn = (from = 0.6): Keyframe[] => [{ opacity: 0, offset: 0 }, { opacity: 0, offset: from }, { opacity: 1 }];
  const hold: Keyframe[] = [{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.999 }, { opacity: 1 }];

  let total = D;
  if (!chart || !outline || !page || !layer) {
    total = 1;
  } else if (reducedMotion()) {
    // One then the other: the chart is fully gone before the page begins, so nothing shows through a half-faded page.
    add(chart, [{ opacity: 1 }, { opacity: 0 }], { duration: F, easing: "linear" });
    add(outline, [{ opacity: 0 }, { opacity: 1 }], { duration: F, delay: F, easing: "linear" });
    add(page, [{ opacity: 0 }, { opacity: 1 }], { duration: F, delay: F, easing: "linear" });
    total = F * 2;
  } else {
    const canvas = chart.querySelector('[data-fold="canvas"]');
    const tree = outline.querySelector('[data-fold="tree"]');
    const view = canvas ? rel(canvas, host) : { x: 0, y: 0, w: 0, h: 0 };
    const treeBox = tree ? rel(tree, host) : { x: 0, y: 0, w: 0, h: 0 };
    const rows = [...outline.querySelectorAll<HTMLElement>(".orow[data-member]")];
    const cards = new Map([...chart.querySelectorAll<HTMLElement>('[data-fold="canvas"] [data-member]')].map((c) => [c.dataset.member as string, c]));
    layer.replaceChildren();

    // Who travels (on screen at both ends), and how far each starts from the outline.
    const travellers: { row: HTMLElement; card: HTMLElement; a: R; b: R; id: string }[] = [];
    const arrivals: HTMLElement[] = [];
    let inView = 0;
    for (const row of rows) {
      const id = row.dataset.member as string;
      const card = cards.get(id);
      const a = card ? rel(card, host) : null;
      const b = rel(row, host);
      if (fullyInside(b, treeBox)) inView++;
      if (!card || !a || !inside(a, view) || !fullyInside(b, treeBox)) arrivals.push(row);
      else travellers.push({ row, card, a, b, id });
    }
    // When the outline lands scrolled away from what the chart showed, only a row or two would travel, alone across an
    // emptied canvas. Then the chart fades as a whole and the outline arrives as one group instead.
    if (travellers.length < 3 || travellers.length < inView * 0.4) {
      add(chart, fadeOut(0.35), lin);
      add(outline, fadeIn(0.35), lin);
      const pageBox = rel(page, host);
      add(page, [{ transform: `translateX(${host.width - pageBox.x}px)` }, { transform: "translateX(0)" }]);
      travellers.length = 0;
      arrivals.length = 0;
    }
    for (const row of arrivals) add(row, fadeIn(0.6), lin);
    const grouped = travellers.length === 0;
    const xs = travellers.map((t) => t.a.x);
    const minX = Math.min(...xs), range = Math.max(1, Math.max(...xs) - minX);

    let i = 0;
    for (const { row, card, a, b, id } of travellers) {
      const d = Math.round(((a.x - minX) / range) * SPREAD) + i++ * STAG;
      const sel = id === selectedId;
      const part = (el: Element, p: string) => el.querySelector<HTMLElement>(`[data-part="${p}"]`);
      const local = (el: HTMLElement | null, box: R) => (el && shown(el) ? (() => { const r = rel(el, host); return { ...r, x: r.x - box.x, y: r.y - box.y }; })() : null);

      // The travelling copy: a frame, and each part placed absolutely where it sits on the card.
      const n = document.createElement("div");
      n.className = "fnode";
      n.style.cssText = `left:${a.x}px;top:${a.y}px;width:${a.w}px;height:${a.h}px;z-index:${i}`;
      const frame = document.createElement("span");
      frame.className = "fnode-frame";
      n.appendChild(frame);
      layer.appendChild(n);
      const place = (src: HTMLElement, at: R, extra = "") => {
        const c = src.cloneNode(true) as HTMLElement;
        c.removeAttribute("data-part");
        c.classList.add("fpart");
        c.style.cssText = `left:${at.x}px;top:${at.y}px;width:${at.w}px;height:${at.h}px;${extra}`;
        n.appendChild(c);
        return c;
      };
      const gather: KeyframeAnimationOptions = { duration: D * 0.6, easing: snap, delay: d };
      // The kept line holds still until the lines it would pass over have faded (they are gone by 15%).
      const after = (from: Keyframe, to: Keyframe): Keyframe[] => [{ ...from, offset: 0 }, { ...from, offset: 0.3 }, { ...to, offset: 1 }];
      const glide: KeyframeAnimationOptions = { delay: d };
      const linD: KeyframeAnimationOptions = { delay: d, easing: "linear" };
      add(n, [{ width: `${a.w}px`, height: `${a.h}px` }, { width: `${b.w}px`, height: `${b.h}px` }], gather);
      add(n, [{ left: `${a.x}px`, top: `${a.y}px` }, { left: `${b.x}px`, top: `${b.y}px` }], glide);
      add(frame, [
        { boxShadow: "inset 0 0 0 1px var(--line-card)", background: "var(--surface)", borderRadius: "6px", offset: 0 },
        { boxShadow: "inset 0 0 0 1px transparent", background: "var(--surface)", offset: 0.5 },
        { background: "var(--canvas)", offset: 0.8 },
        { boxShadow: "inset 0 0 0 1px transparent", background: "var(--canvas)", borderRadius: "5px" },
      ], linD);
      // The open person's selection lands once their row has settled: the fill arrives over a beat, and each word turns
      // light the moment the fill is more than half dark, never mid-grey on mid-grey for long.
      const SEL = ms("--d-ui");
      const landed: KeyframeAnimationOptions = { duration: SEL, delay: d + D, easing: "linear" };
      const flip = (el: Element, from: string, to: string) => add(el, [{ color: from, offset: 0 }, { color: from, offset: 0.5 }, { color: to, offset: 0.501 }, { color: to }], landed);
      if (sel) add(frame, [{ background: "var(--canvas)" }, { background: "var(--sel)" }], landed);

      // Avatar: moves and scales to the row's.
      const cAv = local(part(card, "av"), a), rAv = local(part(row, "av"), b);
      if (cAv && rAv) {
        const av = place(part(card, "av") as HTMLElement, { ...cAv, x: 0, y: 0 }, "transform-origin:0 0;");
        add(av, [{ transform: `translate(${cAv.x}px, ${cAv.y}px) scale(1)` }, { transform: `translate(${rAv.x}px, ${rAv.y}px) scale(${rAv.w / cAv.w})` }], gather);
      }
      // Name: travels; the surname leaves where the outline shows first names only.
      const cN = local(part(card, "name"), a), rN = local(part(row, "name"), b);
      if (cN && rN) {
        const nm = place(part(card, "name") as HTMLElement, { ...cN, w: Math.max(cN.w, rN.w) }, "white-space:nowrap;overflow:visible;");
        add(nm, [{ left: `${cN.x}px`, top: `${cN.y}px` }, { left: `${rN.x}px`, top: `${rN.y}px` }], gather);
        const last = nm.querySelector(".name-last");
        const rowLast = row.querySelector(".name-last");
        if (last && !shown(rowLast)) add(last, fadeOut(0.25), linD);
        if (sel) flip(nm, "var(--ink)", "var(--sel-ink)");
      }
      // The second line the outline keeps travels to it; the rest of the card's lines fade early.
      const rowLine = part(row, "line");
      const keepKind = rowLine && shown(rowLine) ? rowLine.dataset.kind : null;
      const kept = keepKind === "state" ? part(card, "state") : keepKind === "role" ? part(card, "role") : null;
      for (const p of ["role", "state", "glance", "kind"]) {
        const src = part(card, p);
        const at = local(src, a);
        if (!src || !at) continue;
        const copy = place(src, at, "white-space:nowrap;");
        if (src === kept && rowLine) {
          const rL = local(rowLine, b) as R;
          // The text lands on the row's text; a state's dot shrinks away on the way.
          const text = src.querySelector(".mcard-trunc") ?? src;
          const offset = rel(text, host).x - rel(src, host).x;
          add(copy, after({ left: `${at.x}px`, top: `${at.y}px` }, { left: `${rL.x - offset}px`, top: `${rL.y}px` }), gather);
          const dot = copy.querySelector(".mcard-dot");
          if (dot) add(dot, [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.4)", offset: 0.4 }, { opacity: 0, transform: "scale(0.4)" }], linD);
          if (sel) {
            const to = rowLine.classList.contains("orow-live") ? "var(--sel-live)" : rowLine.classList.contains("orow-attn") || rowLine.classList.contains("orow-fail") ? "var(--sel-attn)" : "var(--sel-muted)";
            flip(copy, getComputedStyle(src).color, to);
          }
        } else {
          add(copy, fadeOut(0.15), linD);
        }
      }
      // A row line no card part carries (the card showed something else) fades in where it will be.
      if (rowLine && shown(rowLine) && !kept) {
        const rL = local(rowLine, b) as R;
        const copy = place(rowLine, rL, "white-space:nowrap;");
        add(copy, fadeIn(0.55), linD);
        if (sel) flip(copy, getComputedStyle(rowLine).color, "var(--sel-muted)");
      }
      // The real row stays hidden until its copy lands on it.
      add(row, hold, { ...lin, delay: d });
      total = Math.max(total, D + d + (sel ? SEL : 0));
    }

    // The chart's lines and grid go first; the outline's tree lines draw in last.
    if (canvas && !grouped) add(canvas, fadeOut(0.2), lin);
    const lines = outline.querySelector('[data-fold="lines"]');
    if (lines && !grouped) add(lines, fadeIn(0.6), { ...lin, duration: total });
    // Where the outline's head carries a rule the chart's does not (the smallest window, where the outline has no filter
    // row), that rule fades in after the chart's filter row and its rule have gone, so two rules never show at once.
    const ch = chart.querySelector(".org-head"), oh = outline.querySelector(".org-head");
    if (!grouped && oh && ch && oh.classList.contains("org-head-ruled") && !ch.classList.contains("org-head-ruled")) {
      add(oh, [{ boxShadow: "inset 0 -1px 0 transparent", offset: 0 }, { boxShadow: "inset 0 -1px 0 transparent", offset: 0.55 }, { boxShadow: "inset 0 -1px 0 var(--line)" }], lin);
    }
    // Head, filter and foot: where the outline's copy matches the chart's exactly, the chart's simply stays; where they
    // differ (the tool at the head's end, the smallest window's foot), they crossfade in place.
    for (const p of grouped ? [] : ["title", "views", "foot", "tool"]) {
      const mine = chart.querySelector(`[data-pair="${p}"]`);
      const theirs = outline.querySelector(`[data-pair="${p}"]`);
      const ma = shown(mine) ? rel(mine, host) : null, ta = shown(theirs) ? rel(theirs, host) : null;
      const same = !!(mine && theirs && ma && ta) && mine.textContent === theirs.textContent && Math.abs(ma.x - ta.x) < 1 && Math.abs(ma.y - ta.y) < 1 && Math.abs(ma.w - ta.w) < 1;
      if (same) { add(theirs as Element, hold, lin); continue; }
      // The title changes size (the outline's is a step down): both copies scale together from the left as they swap,
      // so it reads as one title settling.
      const fm = mine ? parseFloat(getComputedStyle(mine).fontSize) : 0, ft = theirs ? parseFloat(getComputedStyle(theirs).fontSize) : 0;
      if (p === "title" && mine && theirs && ma && ta && fm && ft && fm !== ft) {
        const k = ft / fm;
        const o = { duration: D, easing: snap };
        (mine as HTMLElement).style.transformOrigin = (theirs as HTMLElement).style.transformOrigin = "0 50%";
        add(mine, [{ transform: "scale(1)", opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0, offset: 0.6 }, { transform: `scale(${k})`, opacity: 0 }], o);
        add(theirs, [{ transform: `scale(${1 / k})`, opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1, offset: 0.6 }, { transform: "scale(1)", opacity: 1 }], o);
        continue;
      }
      if (mine && ma) add(mine, fadeOut(0.35), lin);
      if (theirs && ta) add(theirs, fadeIn(0.55), lin);
    }
    // The page rides the outline's edge in from the window's edge, opaque from its first frame. Closing, it leaves at
    // once, on the click, with the rows overlapping it (it sits at the end of the timeline, which closing plays first).
    if (!grouped) {
      const pageBox = rel(page, host);
      // Closing plays the timeline backwards, which would turn the page's soft landing into a slow start: there it takes
      // the travel curve mirrored in time, so backwards it departs at once and still travels on --ease-move.
      const mirrored = "cubic-bezier(0.9, 0, 0.55, 1)";
      add(page, [{ transform: `translateX(${host.width - pageBox.x}px)` }, { transform: "translateX(0)" }],
        target === "chart" ? { delay: Math.max(0, total - D), easing: mirrored } : {});
    }
  }

  // Every part ends together, so turning round mid-way retraces the same frames in step.
  for (const a of anims) {
    const end = a.effect?.getComputedTiming().endTime;
    if (typeof end === "number" && end < total) a.effect?.updateTiming({ endDelay: total - end });
  }
  // One animation spanning the whole move says when it lands, whichever way it is going.
  const master = (layer ?? root).animate([{ opacity: 1 }, { opacity: 1 }], { duration: total, fill: "both" });
  anims.push(master);
  master.onfinish = () => landed?.(current);

  if (target === "chart") {
    // Closing: the same move, from its end, backwards.
    for (const a of anims) {
      const end = a.effect?.getComputedTiming().endTime;
      a.currentTime = typeof end === "number" ? end : total;
      a.playbackRate = -1;
      a.play();
    }
  }

  return {
    toward: (t) => {
      if (t === current) return;
      current = t;
      for (const a of anims) a.reverse();
    },
    onLand: (cb) => { landed = cb; },
    cleanup: () => {
      for (const a of anims) a.cancel();
      layer?.replaceChildren();
    },
  };
}
