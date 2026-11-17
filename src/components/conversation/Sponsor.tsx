import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { EmployeeView } from "../../api/types";
import { firstName } from "../../lib/format";
import type { LiveRun } from "../../lib/runs";
import { Icon } from "../Icon";
import { openWeb } from "./CardLink";
import vibeTyper from "./vibe-typer.svg";
import { pauseWord, seedOf } from "./work";

// The work line in a pause between steps: it moves on every so long, through the thinking words and, every third move,
// a line about Vibe Typer (voice typing from the same maker). An ad stays long enough to read, even when work starts
// again meanwhile.

/** `ref` tells the site's analytics the visit came from OmegaStar. */
const SITE = new URL("https://vibetyper.com/?ref=omegastar");
/** How long a thinking word stays before the line moves on. */
const WORD_MS = 4000;
/** How long an ad stays, whatever the reply does meanwhile. */
const AD_MS = 5000;
/** A prompt this long or longer, that you wrote, is one the prompt lines can talk about: about a dozen words. */
const LONG_PROMPT = 60;

// Each line up to its link, which is always "Vibe Typer", last
const ABOUT_THE_PROMPT = [
  "That prompt would've been way faster with",
  "Typed all that? Next time, just say it with",
  "You could've just said that. Try",
  "Rest your fingers. Say the next one with",
  "While {name} works, say your next prompt with",
];
const ANYWHERE = [
  "Talk, don't type. Try",
  "Prompts are easier said than typed. Try",
  "Your voice is faster than your fingers. Try",
  "Ums and all, it comes out clean with",
  "Think out loud and send it polished with",
  "Voice typing that thinks:",
  "Talk into any app, this one included, with",
];

type Move = { pause: number; t: number };

/** What the line says in place of nowOf's: a later word in a long pause, or an ad (`ad`) while one is on show; null
 *  for nowOf's own (a step, or a pause's first word). `pause` is nowOf's, null when not in one. The prompt lines need
 *  a long prompt you wrote (`prompt`, what you said to start this stretch). */
export function usePauseLine(turn: LiveRun, e: EmployeeView, prompt: string, pause: number | null): { key: string; words: string; ad: boolean } | null {
  const id = turn.run.id;
  const [at, setAt] = useState<{ pause: number | null; t: number }>({ pause, t: 0 });
  const [held, setHeld] = useState<Move | null>(null);
  if (at.pause !== pause) setAt({ pause, t: 0 });
  const t = at.pause === pause ? at.t : 0;

  // Move on every so long; every third move is an ad, which holds the line
  useEffect(() => {
    if (pause === null || held) return;
    const timer = window.setTimeout(() => {
      setAt({ pause, t: t + 1 });
      if ((t + 1) % 3 === 1) setHeld({ pause, t: t + 1 });
    }, WORD_MS);
    return () => window.clearTimeout(timer);
  }, [pause, t, held]);
  // Let the ad go, and move past it if the pause is still on
  useEffect(() => {
    if (!held) return;
    const timer = window.setTimeout(() => {
      setHeld(null);
      setAt((a) => (a.pause === held.pause && a.t === held.t ? { ...a, t: a.t + 1 } : a));
    }, AD_MS);
    return () => window.clearTimeout(timer);
  }, [held]);

  if (held) {
    const lines = !turn.run.omegaWrote && prompt.trim().length >= LONG_PROMPT ? [...ABOUT_THE_PROMPT, ...ANYWHERE] : ANYWHERE;
    const words = lines[(seedOf(id) + held.pause + held.t) % lines.length].replace("{name}", firstName(e.name));
    return { key: `ad:${held.pause}:${held.t}`, words, ad: true };
  }
  return pause === null || t === 0 ? null : { key: `pause:${pause}:${t}`, words: pauseWord(id, pause + t), ad: false };
}

/** The ad in the line: its words in the muted ink, as it is not work, then Vibe Typer, which opens the site. The line is
 *  a button (it opens the steps), so the link is a span that keeps its click to itself. */
export function SponsorWords({ words }: { words: string }) {
  const open = (ev: MouseEvent | KeyboardEvent) => {
    ev.stopPropagation();
    openWeb(SITE);
  };
  return (
    <>
      <span className="wl-ad">{words}</span>
      <span
        role="link" tabIndex={0} className="wl-vt" data-tip={SITE.host}
        onClick={open} onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); open(ev); } }}
      >
        <img src={vibeTyper} alt="" width={14} height={14} />
        <span className="wl-vt-name">Vibe Typer</span>
        <Icon name="arrowUpRight" size={12} className="wl-vt-arrow" />
      </span>
    </>
  );
}
