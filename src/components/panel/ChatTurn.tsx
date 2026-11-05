import { Fragment, useMemo, useRef, type ReactNode } from "react";
import { call, errorMessage } from "../../api/client";
import type { EmployeeView, Run } from "../../api/types";
import { firstName, heldLabel, threadTitle, timeOrDay, dateLong } from "../../lib/format";
import { useNow, useOrg, useProposals, useQuery, useUsage } from "../../lib/hooks";
import { toast } from "../../lib/toasts";
import type { LiveRun } from "../../lib/runs";
import { navigate, openMember, openRun } from "../../lib/router";
import { kindNames } from "../RunRow";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";
import { ProposedRow, RequestedRow, toItems, type TranscriptItem } from "../Transcript";
import { Visual } from "../Visual";
import { Avatar, ErrorNote, Roll } from "../ui";
import { useWorkFocus } from "../conversation/LiveWork";
import { chipsOf, minutes, partsOf, type Chip } from "../conversation/work";
import "./ChatTab.css";

const isImage = (name: string) => /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(name);

/** Who a reply is from and where it stands: "Juniper working, 3 min", "up next", or the time it finished. */
export function WhoLine({ e, run, label, last = true }: { e: EmployeeView; run: Run; label?: string; last?: boolean }) {
  const running = run.state === "running";
  const now = useNow(30_000, running && last);
  const at = run.endedAt;
  // One meta slot, beside the name, for every turn: where it stands while it runs, else when it finished.
  const meta = label ? <span className="who-meta">{label}</span>
    : !last ? null
    : run.state === "queued" ? <span className="who-meta">up next</span>
    : running ? <span className="who-meta who-live">working{run.startedAt ? <>, <Roll value={minutes(now - Date.parse(run.startedAt))} /></> : null}</span>
    : at ? <span className="who-meta num" title={dateLong(at)}>{timeOrDay(at)}</span> : null;
  return (
    <div className="who-line">
      <Avatar name={e.name} hue={e.hue} size={22} />
      <b>{firstName(e.name)}</b>
      {meta}
    </div>
  );
}

/** The chips of a part: they point at the work in the Live work column, or open the skill that changed. */
export function Refs({ chips, e, runId }: { chips: Chip[]; e: EmployeeView; runId: string }) {
  const focus = useWorkFocus();
  // Chips there when the conversation opened are simply there; one that arrives while you watch drops in.
  const seen = useRef<Map<string, number> | null>(null);
  const first = !seen.current;
  seen.current ??= new Map();
  const now = Date.now();
  for (const c of chips) if (!seen.current.has(c.key)) seen.current.set(c.key, first ? 0 : now);
  const fresh = new Set(chips.filter((c) => now - (seen.current!.get(c.key) ?? 0) < 600).map((c) => c.key));
  if (!chips.length) return null;
  return (
    <div className="refs">
      {chips.map((c) => {
        const open = c.skill ? () => openMember(e.id, "skills", `diff~${runId}~${c.skill!.skill}~${c.skill!.file}`) : focus && c.target ? () => focus(c.target!) : undefined;
        return (
          <button key={c.key} type="button" className={`ref ${c.live ? "ref-live" : ""} ${fresh.has(c.key) ? "enter-drop" : ""}`} disabled={!open} onClick={open}
            data-tip={c.skill ? "See what changed" : open ? "Show in Live work" : undefined}>
            {c.avatar ? <Avatar name={c.avatar.name} hue={c.avatar.hue} size={16} /> : c.icon ? <Icon name={c.icon} size={14} /> : null}
            <span className="ref-label">{c.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * One exchange in a conversation: what you sent (with any files), then the employee's reply as it streams in. A message
 * you sent while it worked splits the reply where it landed. Each part reads as a colleague talking: their first words,
 * one line of chips for the work (which lives in the Live work column), any page they showed, then the answer.
 * `withReport` shows a finished run's report when its transcript did not already say it. `footer` sits at the end of the
 * reply, on its text edge: the cards it asks, a blocked action, Retry.
 */
export function Turn({ turn, e, withReport = false, footer, earlier = false, latestMine = false }: {
  turn: LiveRun; e: EmployeeView; withReport?: boolean; footer?: ReactNode;
  /** A turn before the latest: its words step back to the secondary ink, so the latest exchange leads. */
  earlier?: boolean;
  /** This turn holds your latest message, the one solid block; your earlier messages are a quiet step. */
  latestMine?: boolean;
}) {
  const { snap } = useOrg();
  const proposals = useProposals();
  const items = useMemo(() => toItems(turn.events), [turn.events]);
  const parts = useMemo(() => partsOf(items), [items]);
  const employees = snap?.employees ?? [];
  const running = turn.run.state === "running" || turn.run.state === "queued";
  const queued = turn.run.state === "queued";
  const failed = turn.run.state === "failed" || turn.run.state === "lost" || turn.run.state === "cancelled";
  const report = turn.run.summary?.trim();
  const showReport = withReport && !running && !!report && !items.some((i) => i.kind === "text" && i.text.trim() === report);
  // A colleague's report or answer that came back, or a check that came due: Omega Star wrote the prompt, so it is not
  // shown as yours.
  const came = turn.run.kind.type === "answered" ? turn.run.kind : null;
  const fromName = came ? snap?.employees.find((x) => x.id === came.from)?.name : undefined;
  const who = fromName ? firstName(fromName) : "A colleague";
  // Your messages in this turn, in order; the last of them is your latest when `latestMine`.
  const mine = [turn.run.prompt && !came && !turn.run.check ? "prompt" : null, ...parts.map((p, i) => (p.said !== null ? `said:${i}` : null))].filter(Boolean) as string[];
  const lastMine = latestMine ? mine[mine.length - 1] : null;
  const me = (key: string) => `msg-me ${key === lastMine ? "msg-me-latest" : ""}`;
  const result = (it: TranscriptItem) => {
    switch (it.kind) {
      case "requested": return <RequestedRow key={it.key} personId={it.personId} reqKind={it.reqKind} message={it.message} people={snap?.people ?? []} />;
      case "proposed": return <ProposedRow key={it.key} name={it.name} title={it.title} proposal={proposals?.find((p) => p.id === it.proposalId)} />;
      case "visual": return <Visual key={it.key} runId={turn.run.id} id={it.id} title={it.title} from={firstName(e.name)} />;
      case "result": return !it.ok && it.text ? <ErrorNote key={it.key} text={it.text} /> : null;
      default: return null;
    }
  };
  return (
    <div className={`turn ${earlier ? "turn-earlier" : ""}`}>
      {turn.run.attachments.length ? (
        <div className="msg-files">
          {turn.run.attachments.map((a) => (
            <button key={a} className="attach attach-sent" data-tip={`Open ${a}`} onClick={() => call("open_attachment", { runId: turn.run.id, name: a }).catch((err) => toast(errorMessage(err), "err"))}>
              <Icon name={isImage(a) ? "image" : "file"} size={13} /><span className="attach-name">{a}</span>
            </button>
          ))}
        </div>
      ) : null}
      {came ? (
        <details className="msg-came">
          <summary><Icon name="reply" size={14} /> {came.task ? `${who}'s report came back` : `${who} answered`}<Icon name="chevronDown" size={13} className="msg-came-chev" /></summary>
          <div className="msg-came-body"><Markdown text={turn.run.prompt} /></div>
        </details>
      ) : turn.run.check ? (
        <details className="msg-came">
          <summary><Icon name="clock" size={14} /> {firstName(e.name)}'s check came due<Icon name="chevronDown" size={13} className="msg-came-chev" /></summary>
          <div className="msg-came-body"><Markdown text={turn.run.prompt} /></div>
        </details>
      ) : turn.run.prompt ? <div className={me("prompt")}>{turn.run.prompt}</div> : null}
      {parts.map((part, i) => {
        const last = i === parts.length - 1;
        const chips = chipsOf(part, turn, employees);
        const rest = part.items.filter((it) => it.kind === "requested" || it.kind === "proposed" || it.kind === "visual" || it.kind === "result");
        const empty = !part.items.length && !(last && (turn.live || showReport || running || failed || footer));
        return (
          <Fragment key={i}>
            {part.said !== null ? <div className={me(`said:${i}`)}>{part.said}</div> : null}
            {empty ? null : (
              <div className="msg-emp">
                <WhoLine e={e} run={turn.run} last={last} />
                <div className="msg-body">
                  {part.opener ? <Markdown text={part.opener.text} /> : null}
                  <Refs chips={chips} e={e} runId={turn.run.id} />
                  {rest.map(result)}
                  {part.answer.map((t) => <Markdown key={t.key} text={t.text} />)}
                  {last ? (
                    <>
                      {/* The caret sits against the last letter: a chunk's trailing space is not shown. */}
                      {turn.live.trim() ? <Markdown text={turn.live.replace(/\s+$/, "")} className="md-live" /> : null}
                      {showReport ? <Markdown text={report} /> : null}
                      {queued ? <Waiting run={turn.run} e={e} /> : null}
                      {failed && !running ? <p className="msg-failed"><Icon name="alert" size={14} /><span>{turn.run.error ?? "This reply didn't finish."}</span></p> : null}
                      {footer}
                    </>
                  ) : null}
                </div>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/** A run that has not started: what it waits for (the usage limit, the runs ahead of it, a free slot), and what is ahead
 *  of it in its employee's line, each opening its run. The same words as the run page. */
export function Waiting({ run, e }: { run: Run; e: EmployeeView }) {
  const { usage } = useUsage();
  const { snap } = useOrg();
  const now = useNow(60_000);
  const lanes = useQuery(() => call("settings"), []).data?.maxConcurrentRuns ?? 1; // also each employee's limit
  const name = firstName(e.name);
  const others = (e.live ?? []).filter((r) => r.id !== run.id);
  const working = others.filter((r) => r.state === "running");
  const ahead = others.filter((r) => r.state === "queued" && r.createdAt < run.createdAt);
  const held = usage?.heldUntil && Date.parse(usage.heldUntil) > now ? usage.heldUntil : null;
  const why = held ? `${heldLabel(held, new Date(now))}.`
    : working.length >= lanes ? `${name} starts this once ${working.length === 1 ? "the run below" : "one of the runs below"} finishes.`
    : ahead.length ? `${name} starts this after ${ahead.length === 1 ? "the run" : `the ${ahead.length} runs`} ahead of it.`
    : `${name} starts this as soon as there's room.`;
  const line = [...working, ...ahead];
  return (
    <div className="task-wait">
      <p className="task-wait-why">{why}</p>
      {line.length ? (
        <div className="task-wait-list">
          <span className="task-wait-label">Ahead of it</span>
          {line.map((r) => (
            <button key={r.id} type="button" className="task-wait-row" onClick={() => openRun(r.id)}>
              <span className="task-wait-what">{threadTitle(r, kindNames(r, snap?.employees ?? [], snap?.people ?? []))}</span>
              <span className={`status ${r.state === "running" ? "status-live" : "status-wait"}`}>{r.state === "running" ? "Working" : "Up next"}</span>
            </button>
          ))}
        </div>
      ) : held ? null : (
        <button className="btn btn-ghost btn-sm task-wait-link" onClick={() => navigate({ page: "settings" })}>
          Change how many run at once <Icon name="arrowUpRight" size={12} />
        </button>
      )}
    </div>
  );
}
