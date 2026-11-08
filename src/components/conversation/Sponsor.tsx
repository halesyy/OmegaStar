import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { EmployeeView } from "../../api/types";
import { firstName } from "../../lib/format";
import type { LiveRun } from "../../lib/runs";
import { Icon } from "../Icon";
import { openWeb } from "./CardLink";
import vibeTyper from "./vibe-typer.svg";
import { seedOf } from "./work";

// Vibe Typer, voice typing from the same maker, said once a reply in the work line, in a pause between steps that has
// gone on a while: never in place of real work, and never twice in one reply.

/** `ref` tells the site's analytics (AnalyticsTracker on vibetyper.com) the visit came from Omega Star. */
const SITE = new URL("https://vibetyper.com/?ref=omegastar");
/** How long a pause lasts before the ad takes its place. */
const AFTER_MS = 2500;
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

/** The pause each run showed the ad in, so every line showing the run agrees, and it never shows again. */
const shownIn = new Map<string, string>();

/** The ad's words for a run, or null: only in a pause (`gap`, the line's key for it) that has lasted, once a run. The
 *  prompt lines need a long prompt you wrote (`prompt`, what you said to start this stretch). */
export function useSponsor(turn: LiveRun, e: EmployeeView, prompt: string, gap: string | null): string | null {
  const id = turn.run.id;
  const [, wake] = useState(0);
  useEffect(() => {
    if (!gap || shownIn.has(id)) return;
    const t = window.setTimeout(() => {
      if (!shownIn.has(id)) shownIn.set(id, gap);
      wake((n) => n + 1);
    }, AFTER_MS);
    return () => window.clearTimeout(t);
  }, [id, gap]);
  if (!gap || shownIn.get(id) !== gap) return null;
  const lines = !turn.run.omegaWrote && prompt.trim().length >= LONG_PROMPT ? [...ABOUT_THE_PROMPT, ...ANYWHERE] : ANYWHERE;
  return lines[seedOf(id) % lines.length].replace("{name}", firstName(e.name));
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
