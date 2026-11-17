// A message dictated with Vibe Typer, voice typing from the same maker, leaves with a small reward. As it shows in the
// thread, Vibe Typer's butterfly lifts off the Send button and glides out across the conversation on one long sweep,
// a ribbon of colour tapering away behind it. About one send in ten, a whole kaleidoscope of butterflies lifts off the
// message instead. Under the message, "Said with Vibe Typer" shows for a few seconds and fades.
//
// It never takes a click or holds anything up. The flight is a layer over the conversation that lets every click
// through and is gone when the last butterfly leaves; it sits on the page rather than in the conversation, so a new
// conversation opening its thread mid-flight does not cut it short. The line rides inside the message, so it scrolls
// with it and moves nothing. Under reduced motion nothing flies; only the line shows.
//
// A message counts as dictated when Vibe Typer last typed into Omega Star (`last_dictation`) after its words began in
// the composer.
import { call } from "../../api/client";
import { reducedMotion } from "../../lib/motion";
import mark from "./vibe-typer.svg";
import markSource from "./vibe-typer.svg?raw";
import "./VibeReward.css";

/** Vibe Typer notes the time as it pastes, which can be a moment before the composer sees the words and starts the draft. */
const GRACE_MS = 1000;
/** How long the message may take to show in the thread after it went: a new conversation opens its thread first. */
const SHOW_MS = 5000;
/** How often a send is a kaleidoscope rather than a glide: about one in ten. */
const KALEIDOSCOPE = 0.1;
/** How long "Said with Vibe Typer" stays under the message, fading in and out. */
const SAID_MS = 3800;

/** One flight. `id` counts them and picks the glide's route and the kaleidoscope's scatter. */
type Reward = { id: number; kind: "glide" | "kaleidoscope" };
/** A point in the conversation pane, in pixels from its top left. */
type Waypoint = [number, number];
/** The glide at one moment: `u` of its time, `s` pixels along its curve, where it is and how far it leans. */
type Sample = { u: number; s: number; x: number; y: number; lean: number };
/** A kaleidoscope butterfly at one moment: `u` of its time, where it is and how far it tilts toward its heading. */
type Step = { u: number; x: number; y: number; ang: number };

/** The mark's shapes, filled from `--w0` to `--w2` so each theme, and each butterfly in a kaleidoscope, colours it. */
const SHAPES = [...markSource.matchAll(/<path[^>]*?class="s(\d)"[^>]*?d="([^"]+)"/g)]
  .map(([, n, d]) => `<path fill="var(--w${n})" d="${d}"/>`)
  .join("");
/** The ribbon's colours, from the Send button to where the butterfly leaves. */
const BRIGHT = ["rgb(255,116,82)", "rgb(242,163,58)", "rgb(47,199,117)", "rgb(107,147,255)", "rgb(167,139,250)"];

/** The glide's ways out of a pane `w` by `h`: from the Send button `s`, off the left or top edge. */
const ROUTES: ((w: number, h: number, s: Waypoint) => Waypoint[])[] = [
  (w, h, s) => [s, [w * 0.76, h * 0.6], [w * 0.5, h * 0.46], [w * 0.3, h * 0.34], [w * 0.14, h * 0.16], [-60, h * 0.02]],
  (w, h, s) => [s, [w * 0.72, h * 0.64], [w * 0.46, h * 0.52], [w * 0.3, h * 0.3], [w * 0.46, h * 0.12], [w * 0.74, -60]],
  (w, h, s) => [s, [w * 0.8, h * 0.54], [w * 0.6, h * 0.34], [w * 0.38, h * 0.4], [w * 0.2, h * 0.24], [w * 0.1, -60]],
];

/** The glide: the butterfly's size in pixels, its time in milliseconds, the moments its curve is cut into and the ribbon's layers. */
const GLIDE = { size: 56, duration: 2300, samples: 120, layers: 14 };
/** The share of the glide's time spent lifting off; after it, one even speed all the way out. */
const LIFT = 0.3;

/** Eases 0 to 1 in and out (smoothstep), holding at either end outside that range. */
const soft = (t: number) => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

/** The share of the glide's curve covered at `u` of its time: a soft lift-off, then one even speed all the way out. */
const covered = (u: number) => (u < LIFT ? (u * u) / (2 * LIFT * (1 - LIFT / 2)) : (u - LIFT / 2) / (1 - LIFT / 2));

/** One smooth curve through the waypoints, as an SVG path: each span a cubic whose handles follow its neighbours. */
function smoothPath(pts: Waypoint[]): string {
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[i + 1], e = pts[Math.min(pts.length - 1, i + 2)];
    d += ` C${(b[0] + (c[0] - a[0]) / 6).toFixed(1)},${(b[1] + (c[1] - a[1]) / 6).toFixed(1)} ${(c[0] - (e[0] - b[0]) / 6).toFixed(1)},${(c[1] - (e[1] - b[1]) / 6).toFixed(1)} ${c[0].toFixed(1)},${c[1].toFixed(1)}`;
  }
  return d;
}

/**
 * The glide's moments, `samples` + 1 of them, spaced by distance along its curve (`at`, `length` pixels long) so its
 * speed follows `covered`. The lean follows the heading, averaged over a third of a second so it sways and never rocks.
 */
function glideSamples({ at, length, duration, samples }: {
  at: (s: number) => { x: number; y: number };
  length: number;
  duration: number;
  samples: number;
}): Sample[] {
  const raw = Array.from({ length: samples + 1 }, (_, i) => {
    const u = i / samples, s = length * covered(u), p = at(s), a = at(s - 16), b = at(s + 16);
    return { u, s, x: p.x, y: p.y, raw: (22 * (b.x - a.x)) / (Math.hypot(b.x - a.x, b.y - a.y) || 1) };
  });
  const span = Math.round((170 / duration) * samples);
  return raw.map(({ raw: _, ...p }, i) => {
    const near = raw.slice(Math.max(0, i - span), i + span + 1);
    return { ...p, lean: near.reduce((sum, k) => sum + k.raw, 0) / near.length };
  });
}

/** A seeded random source (mulberry32): the same seed scatters a kaleidoscope the same way. */
function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A kaleidoscope butterfly's `n` steps through the waypoints: slower at take-off and at the end, fluttering either side. */
function flutterRoute(pts: Waypoint[], n: number, flutter: number): Step[] {
  const P = [pts[0], ...pts, pts[pts.length - 1]], segs = pts.length - 1;
  const out = Array.from({ length: n }, (_, i) => {
    const u = i / (n - 1), p = (0.45 * u + 0.55 * (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u))) * segs;
    const k = Math.min(Math.floor(p), segs - 1), t = p - k, [a, b, c, d] = [P[k], P[k + 1], P[k + 2], P[k + 3]];
    const at = (j: 0 | 1) => 0.5 * (2 * b[j] + (c[j] - a[j]) * t + (2 * a[j] - 5 * b[j] + 4 * c[j] - d[j]) * t * t + (3 * b[j] - a[j] - 3 * c[j] + d[j]) * t * t * t);
    return { u, x: at(0), y: at(1) };
  });
  return out.map((o, i) => {
    const a = out[Math.max(0, i - 1)], b = out[Math.min(n - 1, i + 1)], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const side = flutter * Math.sin(Math.PI * o.u) * Math.sin(o.u * Math.PI * 9);
    return { u: o.u, x: o.x + (-dy / len) * side, y: o.y + (dx / len) * side, ang: (26 * dx) / len };
  });
}

let plays = 0;

/**
 * Starts watching a message on its way out: `text` is what was sent and `began` when its words started in the composer
 * (null when there were none). Asks when Vibe Typer last typed here at once, alongside the send, and returns what to
 * call once the send went through: if the message was dictated, its reward plays as it shows in the thread.
 */
export function vibeReward(text: string, began: number | null): () => void {
  const before = new Set(document.querySelectorAll(".msg-me"));
  const dictated = began === null
    ? Promise.resolve(false)
    : call("last_dictation").then((at) => at !== null && at >= began - GRACE_MS, () => false);
  return () => void dictated.then((yes) => { if (yes) play(text, before); });
}

/** Plays a reward for `text` once its message shows: one that was not on screen before it went (`before`). Under
 *  reduced motion that is the line alone. */
function play(text: string, before: ReadonlySet<Element>): void {
  const until = performance.now() + SHOW_MS;
  const look = () => {
    const found = [...document.querySelectorAll<HTMLElement>(".chat-scroll .msg-me")].filter((el) => !before.has(el) && el.textContent?.trim() === text);
    const msg = found[found.length - 1];
    if (!msg) {
      if (performance.now() < until) requestAnimationFrame(look);
      return;
    }
    say(msg);
    const pane = msg.closest<HTMLElement>(".chat-talk");
    if (pane && !reducedMotion()) fly({ id: plays++, kind: Math.random() < KALEIDOSCOPE ? "kaleidoscope" : "glide" }, pane, msg);
  };
  look();
}

/** "Said with Vibe Typer" under the message (under its waiting note, when it waits), fading in and out over SAID_MS. */
function say(msg: HTMLElement): void {
  const anchor = msg.closest<HTMLElement>(".msg-wait") ?? msg;
  const line = document.createElement("span");
  line.className = "vr-said";
  line.setAttribute("aria-hidden", "true");
  const name = document.createElement("b");
  name.textContent = "Vibe Typer";
  line.append("Said with", Object.assign(document.createElement("img"), { src: mark, width: 14, height: 14, alt: "" }), name);
  anchor.style.position = "relative";
  anchor.append(line);
  const done = () => { line.remove(); anchor.style.position = ""; };
  line.animate([{ opacity: 0 }, { opacity: 1, offset: 0.09 }, { opacity: 1, offset: 0.86 }, { opacity: 0 }], { duration: SAID_MS, easing: "linear", fill: "both" })
    .finished.then(done, done);
}

/** Flies the reward over the conversation pane `pane`, from its Send button (a glide) or from the message (a kaleidoscope). */
function fly(reward: Reward, pane: HTMLElement, msg: HTMLElement): void {
  const box = pane.getBoundingClientRect();
  const sky = document.createElement("div");
  sky.className = "vr-sky";
  sky.setAttribute("aria-hidden", "true");
  sky.style.cssText = `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`;
  const markId = `vr-mark-${reward.id}`;
  sky.innerHTML = `<svg class="vr-defs"><defs><g id="${markId}">${SHAPES}</g></defs></svg>`;
  document.body.append(sky);
  let anims: Animation[] = [];
  if (reward.kind === "glide") {
    const send = pane.querySelector(".composer-send")?.getBoundingClientRect();
    if (send) {
      const s: Waypoint = [send.left - box.left + send.width / 2, send.top - box.top + send.height / 2];
      anims = glide(sky, markId, ROUTES[reward.id % ROUTES.length](box.width, box.height, s));
    }
  } else {
    const m = msg.getBoundingClientRect();
    anims = kaleidoscope(sky, markId, rng(7 + reward.id * 13), { w: box.width, h: box.height, left: m.left - box.left, width: m.width, mid: m.top - box.top + m.height / 2 });
  }
  void Promise.allSettled(anims.map((a) => a.finished)).then(() => sky.remove());
}

/** An SVG element with these attributes. */
function svgEl<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** The butterfly, `size` pixels square: a body and two wings, each hinged on it and folding in depth. */
function butterfly(markId: string, size: number, kind: "glide" | "beat"): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `vr-fly vr-${kind}`;
  el.style.cssText = `width:${size}px;height:${size}px;--depth:${size * 4}px`;
  const use = `<use href="#${markId}"/>`;
  el.innerHTML = `<svg class="vr-spine" viewBox="250 0 12 512">${use}</svg><div class="vr-pair">`
    + `<div class="vr-w vr-l"><svg viewBox="0 0 256 512">${use}</svg></div><div class="vr-w vr-r"><svg viewBox="256 0 256 512">${use}</svg></div></div>`;
  return el;
}

/** The glide along `way`: the butterfly and its ribbon, each a layer of the one curve. Returns their animations. */
function glide(sky: HTMLElement, markId: string, way: Waypoint[]): Animation[] {
  const { size, duration, samples, layers } = GLIDE;
  const d = smoothPath(way);
  const svg = svgEl("svg", { class: "vr-trail" }), guide = svgEl("path", { d, fill: "none" });
  svg.append(guide);
  sky.append(svg);
  const length = guide.getTotalLength();
  const S = glideSamples({ at: (s) => guide.getPointAtLength(Math.min(length, Math.max(0, s))), length, duration, samples });
  const anims: Animation[] = [];

  // Layers of one curve, each shorter and wider toward the butterfly, add up to one ribbon that tapers and fades.
  const ribbon = `${markId}-ribbon`;
  const grad = svgEl("linearGradient", { id: ribbon, gradientUnits: "userSpaceOnUse", x1: S[0].x, y1: S[0].y, x2: S[samples].x, y2: S[samples].y });
  BRIGHT.forEach((c, i) => grad.append(svgEl("stop", { offset: i / (BRIGHT.length - 1), "stop-color": c })));
  svg.append(grad);
  const speed = length / (duration * (1 - LIFT / 2)), back = size * 0.4;
  for (let i = 0; i < layers; i++) {
    const f = i / (layers - 1), len = 26 + 250 * (1 - f) ** 1.7, total = duration + (len + back) / speed;
    const line = svgEl("path", {
      d, fill: "none", stroke: `url(#${ribbon})`, "stroke-width": (1.2 + 3.8 * f).toFixed(2), "stroke-linecap": "round", "stroke-opacity": 0.2,
      "stroke-dasharray": `${len.toFixed(1)} ${length + len + 80}`, "stroke-dashoffset": len + 8,
    });
    svg.append(line);
    anims.push(line.animate(
      [...S.map((p) => ({ offset: (p.u * duration) / total, strokeDashoffset: len - (p.s - back) })), { offset: 1, strokeDashoffset: -length - 8 }],
      { duration: total, easing: "linear", fill: "both" },
    ));
  }

  const bf = butterfly(markId, size, "glide");
  sky.append(bf);
  anims.push(bf.animate(S.map((p) => ({
    offset: p.u,
    opacity: soft(p.u / 0.07),
    transform: `translate(${(p.x - size / 2).toFixed(2)}px, ${(p.y - size / 2).toFixed(2)}px) rotate(${p.lean.toFixed(2)}deg) scale(${(0.3 + 0.7 * soft(p.u / 0.2)).toFixed(3)})`,
  })), { duration, easing: "linear", fill: "both" }));
  return anims;
}

/**
 * Fourteen butterflies of every size lifting off the message (`left`, `width` and its middle `mid`, in a pane `w` by
 * `h`) and scattering up and out, a third in the mark's own colours and the rest in five more. Returns their animations.
 */
function kaleidoscope(sky: HTMLElement, markId: string, rnd: () => number, { w, h, left, width, mid }: {
  w: number; h: number; left: number; width: number; mid: number;
}): Animation[] {
  return Array.from({ length: 14 }, (_, i) => {
    const x0 = left + width * (0.06 + 0.88 * rnd()), dx = (rnd() - 0.5) * w * 0.7, up = h * (0.45 + 0.4 * rnd());
    const steps = flutterRoute([[x0, mid], [x0 + dx * 0.3 + (rnd() - 0.5) * 80, mid - up * 0.4], [x0 + dx * 0.7 + (rnd() - 0.5) * 80, mid - up * 0.75], [x0 + dx, mid - up]], 44, 4);
    const size = 22 + rnd() * 24, el = butterfly(markId, size, "beat");
    if (i % 3 !== 0) for (const k of [0, 1, 2]) el.style.setProperty(`--w${k}`, `var(--vr-s${(i % 5) + 1})`);
    el.querySelectorAll<HTMLElement>(".vr-w").forEach((wing) => { wing.style.animationDelay = `${-Math.round(rnd() * 150)}ms`; });
    sky.append(el);
    const frames = steps.filter((_, j) => j % 2 === 0 || j === steps.length - 1).map((p) => {
      const late = Math.max(0, (p.u - 0.7) / 0.3), k = p.u < 0.12 ? 0.4 + (0.6 * p.u) / 0.12 : 1;
      return {
        transform: `translate(${(p.x - size / 2).toFixed(1)}px, ${(p.y - size / 2).toFixed(1)}px) rotate(${p.ang.toFixed(1)}deg) scale(${k.toFixed(3)})`,
        opacity: Math.min(1, p.u / 0.06) * (1 - late),
      };
    });
    return el.animate(frames, { duration: 1600 + rnd() * 1000, delay: rnd() * 320, easing: "linear", fill: "both" });
  });
}
