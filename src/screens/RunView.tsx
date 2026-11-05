import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { call, errorMessage } from "../api/client";
import type { EmployeeView, PersonView, Run } from "../api/types";
import { dateLong, elapsedMs, firstName, heldLabel, runStateLabel, whenInline } from "../lib/format";
import { useNow, useOrg, useProposals, useQuery, useRunDetail, useUsage } from "../lib/hooks";
import { useScrollFade } from "../lib/scrollFade";
import { toast } from "../lib/toasts";
import { navigate, openChat, openMember, openRun } from "../lib/router";
import { conversationOf, didNotFinish, threadFocus } from "../lib/threads";
import { kindNames, workLabel } from "../components/RunRow";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { SubAgents } from "../components/SubAgents";
import { Visual } from "../components/Visual";
import { TidyProposal } from "../components/TidyProposal";
import { BlockedCard } from "../components/BlockedCard";
import { RetryButton } from "../components/conversation/ThreadView";
import { LiveStrip, WorkSheet } from "../components/conversation/LiveWork";
import { workOf } from "../components/conversation/work";
import { ProposedRow, RequestedRow, SkillChip, ToolRows, toItems } from "../components/Transcript";
import { Avatar, ConfirmButton, Roll, Skeleton, SkillsGrew } from "../components/ui";
import { ErrorCard } from "./ActivityParts";
import "../components/panel/ChatTab.css";
import "./RunView.css";

/** A step, as the transcript gives it. */
type ToolItem = Parameters<typeof ToolRows>[0]["tools"][number];

/** Wide enough for the talk beside the run's work column. */
const WIDE = 1000;

/** Time in whole minutes for people to read: "3 min", "1 hr 5 min"; null under a minute. */
function minutes(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return null;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} hr ${m % 60} min` : `${h} hr`;
}

/** How long a finished run took: whole minutes, or seconds when it was quick. */
function took(ms: number | null): string {
  return minutes(ms) ?? (ms === null ? "" : `${Math.max(1, Math.round(ms / 1000))} sec`);
}

/** "tomorrow at 6:00 am", "Fri at 8:00 am": a time in the middle of a sentence. */
const atTime = (iso: string) => whenInline(iso).replace(/ (\d{1,2}:\d{2})/, " at $1");

/** A prompt's lines, trimmed and without blanks. */
const promptLines = (prompt: string) => prompt.split("\n").map((l) => l.trim()).filter(Boolean);

/** Whether an element is at least `px` wide, measured before paint and kept up to date. The element is followed as it
 *  mounts (the page's root changes between loading and loaded), so pass the returned callback as its `ref`. */
function useWide(px: number): [(el: HTMLElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    if (!el) return;
    const update = () => setWide(el.clientWidth >= px);
    update();
    const sizes = new ResizeObserver(update);
    sizes.observe(el);
    return () => sizes.disconnect();
  }, [el, px]);
  return [setEl, wide];
}

/**
 * One thing that changes in place: when `k` changes, what it showed leaves with a short rise as the new one rises in, in
 * the same cell, each in its own colour, so a word and its colour always change together. Anchored by its right edge
 * when `end`. On first show it is simply there.
 */
function Swap({ k, children, end = false, className }: { k: string; children: ReactNode; end?: boolean; className?: string }) {
  const last = useRef<ReactNode>(children);
  const [s, setS] = useState<{ k: string; was: ReactNode; wasK: string; moved: boolean }>({ k, was: null, wasK: "", moved: false });
  if (s.k !== k) setS({ k, was: last.current, wasK: s.k, moved: true });
  useLayoutEffect(() => { last.current = children; });
  useEffect(() => {
    if (s.was === null) return;
    const t = window.setTimeout(() => setS((x) => ({ ...x, was: null })), 200);
    return () => window.clearTimeout(t);
  }, [s.was]);
  return (
    <span className={`rv-swap ${end ? "rv-swap-end" : ""} ${className ?? ""}`}>
      {s.was !== null ? <span key={`was~${s.wasK}`} className="rv-swap-cell leave-rise" aria-hidden>{s.was}</span> : null}
      <span key={k} className={`rv-swap-cell ${s.moved ? "enter-rise" : ""}`}>{children}</span>
    </span>
  );
}

/** Mounts closed and opens its own room on the next frame, so what arrives carries what is below it. */
function Reveal({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { const r = requestAnimationFrame(() => setOpen(true)); return () => cancelAnimationFrame(r); }, []);
  return <div className="collapse" data-open={open}><div>{children}</div></div>;
}

export function RunView({ runId }: { runId: string }) {
  const { detail, error, reload } = useRunDetail(runId);
  const { snap } = useOrg();
  const run = detail?.run;
  const live = run?.state === "running" || run?.state === "queued";
  const employees = useMemo(() => snap?.employees ?? [], [snap]);
  const people = useMemo(() => snap?.people ?? [], [snap]);
  const e = employees.find((x) => x.id === run?.employeeId);
  const requests = useQuery(() => (run ? call("requests", { personId: null, employeeId: run.employeeId, state: null }) : Promise.resolve([])), [run?.employeeId], ["request:updated"]);
  const proposals = useProposals();
  const items = useMemo(() => toItems(detail?.events ?? []), [detail?.events]);
  const [page, wide] = useWide(WIDE);
  const scroll = useScrollFade<HTMLDivElement>();
  const back = () => (history.length > 1 ? history.back() : navigate({ page: "org", memberId: null, tab: null, focus: null }));
  // A page that opens on a finished run leads with what came of it; one that finishes while you watch keeps its order,
  // and what came of it opens its room at the end.
  const [opened, setOpened] = useState<{ id: string; done: boolean } | null>(null);
  if (run && opened?.id !== run.id) setOpened({ id: run.id, done: !live });
  // Without the work column (a narrow window) the live work is a strip on the composer, as in a conversation; Show opens
  // the column as a sheet over the talk.
  const [sheet, setSheet] = useState(false);
  const liveCards = useMemo(() => (detail ? workOf([detail], employees).cards : []), [detail, employees]);

  // The area's one error card, in the place it takes on every page: under Back, on the title's left edge.
  if (error) {
    const missing = /not.?found|could not be found/i.test(error);
    return (
      <div className="runview runview-msg">
        <button className="btn btn-ghost btn-sm rv-msg-back" onClick={back}><Icon name="arrowLeft" size={13} /> Back</button>
        {missing ? (
          <ErrorCard alert={false} title="That run could not be found" text="The link may be out of date, or the run belonged to someone who has left." />
        ) : (
          <ErrorCard title="Couldn't open this run" text={error} onRetry={reload} />
        )}
      </div>
    );
  }
  if (!detail || !run) return <RunSkeleton />;

  const name = e ? firstName(e.name) : "They";
  const names = kindNames(run, employees, people);
  const title = workLabel(run, employees, people);
  const result = [...items].reverse().find((i) => i.kind === "result");
  // Once its transcript is gone, the report kept on the run stands in for the last result.
  const report = result?.kind === "result" ? result : detail.transcriptGone && run.summary ? { ok: run.state === "succeeded", text: run.summary } : null;
  const tools: ToolItem[] = items.flatMap((i) => (i.kind === "tools" ? i.tools : []));
  const init = items.find((i) => i.kind === "init");
  const delegated = items.flatMap((i) => (i.kind === "delegated" ? [i] : []));
  const unlisted = detail.children.filter((c) => !delegated.some((d) => d.childRunId === c.id));
  // The instruction is quoted whole when it says more than the title; one that is only the title is not repeated.
  const lines = promptLines(run.prompt);
  const quote = lines.length === 1 && lines[0].replace(/\.$/, "") === title ? "" : run.prompt.trim();
  const quoteLabel = run.kind.type === "followUp" ? "Picked up with" : run.kind.type === "delegated" ? `From ${names.manager ?? "their manager"}` : run.kind.type === "asked" ? `${names.asker ?? "A colleague"} ${run.kind.task ? "handed over" : "asked"}` : run.kind.type === "answered" ? `${names.asker ?? "A colleague"} got back to them` : "Instruction";

  const said = items.map((it) => {
    switch (it.kind) {
      case "user": return <blockquote key={it.key} className="rv-quote"><span className="rv-quote-label">You added</span><p>{it.text}</p></blockquote>;
      // The closing message is the report, shown once rather than twice.
      case "text": return result?.kind === "result" && result.text?.trim() === it.text.trim() ? null : <div key={it.key} className="rv-said"><Markdown text={it.text} /></div>;
      case "skill": return <div key={it.key}><SkillChip skill={it.skill} file={it.file} change={it.change} onClick={e ? () => openMember(e.id, "skills", `diff~${run.id}~${it.skill}~${it.file}`) : undefined} /></div>;
      case "requested": return <RequestedRow key={it.key} personId={it.personId} reqKind={it.reqKind} message={it.message} people={people} request={requests.data?.find((r) => r.id === it.requestId)} />;
      case "proposed": return <ProposedRow key={it.key} name={it.name} title={it.title} proposal={proposals?.find((p) => p.id === it.proposalId)} />;
      case "visual": return <Visual key={it.key} runId={run.id} id={it.id} title={it.title} />;
      case "stderr": return <pre key={it.key} className="rv-stderr mono">{it.text}</pre>;
      default: return null;
    }
  }).filter(Boolean);

  const outcome = (
    <>
      {run.state === "succeeded" && run.denials.length && run.endedAt && !run.archivedAt ? <BlockedCard run={run} employee={e} /> : null}
      <TidyProposal run={run} employee={e} />
      {didNotFinish(run) ? (
        <DidNotFinish run={run} name={name} text={report?.text || run.error || null} />
      ) : report ? (
        <section className="rv-report" aria-label="Report">
          <div className="rv-report-head"><Icon name="checkCircle" size={14} /> {name}'s report</div>
          {report.text ? <div className="rv-said"><Markdown text={report.text} /></div> : <p className="rv-note">No report.</p>}
          {run.skillChanges.length ? <div><SkillsGrew run={run} /></div> : null}
        </section>
      ) : null}
    </>
  );
  const hasOutcome = didNotFinish(run) || !!report || (run.state === "succeeded" && run.denials.length > 0) || (run.kind.type === "tidy" && !!run.proposed);
  const leadWithOutcome = !!opened?.done && !live && hasOutcome;
  const talking = said.length > 0 || !!detail.live;

  const work = (
    <>
      {detail.tasks.length ? <div className="rv-work-sec"><SubAgents tasks={detail.tasks} runActive={!!live} /></div> : null}
      {delegated.length || unlisted.length ? (
        <section className="rv-work-sec">
          <h2 className="rv-work-title">Handed to colleagues</h2>
          <div className="rv-hand-list">
            {delegated.map((d) => <HandRow key={d.key} childId={d.childRunId} employeeId={d.employeeId} task={d.task} child={detail.children.find((c) => c.id === d.childRunId)} employees={employees} />)}
            {unlisted.map((c) => <HandRow key={c.id} childId={c.id} employeeId={c.employeeId} task={c.prompt} child={c} employees={employees} />)}
          </div>
        </section>
      ) : null}
      {tools.length ? (
        <section className="rv-work-sec">
          <h2 className="rv-work-title">Steps <span className="rv-work-n num"><Roll value={tools.length} /></span></h2>
          <ToolRows tools={tools} running={!!live} tasks={detail.tasks} />
        </section>
      ) : null}
      <section className="rv-work-sec">
        <h2 className="rv-work-title">About this run</h2>
        <Facts facts={[
          { k: "when", label: run.startedAt ? "Started" : "Asked for", value: dateLong(run.startedAt ?? run.createdAt) },
          { k: "by", label: "Asked by", value: askedBy(run, names, e) },
          run.endedAt ? { k: "took", label: "Took", value: took(elapsedMs(run)) } : null,
          run.costUsd !== null ? { k: "used", label: "Used", value: <><span className="num">${run.costUsd < 0.01 ? "<0.01" : run.costUsd.toFixed(2)}</span> <span className="rv-fact-note">at API list price</span></> } : null,
          init?.kind === "init" ? { k: "model", label: "Model", value: <span className="mono">{init.model}</span> } : e?.model ? { k: "model", label: "Model", value: <span className="mono">{e.model}</span> } : null,
          init?.kind === "init" ? { k: "skills", label: "Skills", value: `${init.skills.length} available` } : e ? { k: "skills", label: "Skills", value: e.skills.keys.length && e.skills.keys.length <= 3 ? <span className="mono">{e.skills.keys.join(", ")}</span> : `${e.skills.keys.length} of their own` } : null,
          run.turns ? { k: "turns", label: "Turns", value: <span className="num">{run.turns}</span> } : null,
        ]} />
      </section>
    </>
  );

  return (
    <div ref={page} className="runview" data-wide={wide}>
      <header className="rv-head">
        <button className="btn btn-ghost btn-icon btn-sm rv-back" aria-label="Back" data-tip="Back" onClick={back}><Icon name="arrowLeft" size={14} /></button>
        <div className="rv-id">
          <h1 className="rv-title">{title}</h1>
          <div className="rv-sub">
            {e ? <Avatar name={e.name} hue={e.hue} size={20} /> : null}
            {e ? <button className="rv-who" onClick={() => openMember(e.id, "work")}>{e.name}, {e.title}</button> : <span className="rv-who">Former employee</span>}
            <Links run={run} e={e} names={names} />
            <span className="rv-sep" aria-hidden>·</span>
            {/* Last on the line, so when the word changes nothing beside it moves. */}
            <Swap k={statusKey(run)}><StatusWord run={run} /></Swap>
          </div>
        </div>
        <div className="rv-actions">
          <Swap k={live ? "cancel" : didNotFinish(run) ? "retry" : "none"} end>
            {live ? <ConfirmButton label="Cancel" icon="stop" className="btn" size="btn-sm" question="Stop this run?" confirmLabel="Stop it" onConfirm={() => cancel(run)} />
              : didNotFinish(run) ? <RetryButton run={run} name={name} /> : null}
          </Swap>
        </div>
      </header>
      <div className="rv-body">
        <div className="rv-talk">
          <div ref={scroll} className="rv-scroll scroll-fade">
            <div className="rv-inner">
              {quote ? (
                <blockquote className="rv-quote">
                  <span className="rv-quote-label">{quoteLabel}</span>
                  <p>{quote}</p>
                </blockquote>
              ) : null}
              {run.kind.type === "delegated" || run.kind.type === "asked" ? <Origin parentId={run.kind.parentRunId} employees={employees} people={people} /> : null}
              {run.state === "queued" ? <Waiting run={run} e={e} employees={employees} people={people} /> : null}
              {detail.transcriptGone ? <p className="rv-note">This run's transcript is no longer kept.</p> : null}
              {leadWithOutcome ? outcome : null}
              {leadWithOutcome && talking ? <h2 className="rv-how">How it went</h2> : null}
              {said}
              {detail.live ? <div className="rv-said"><Markdown text={detail.live} className="md-live" /></div> : null}
              {hasOutcome && !live && !leadWithOutcome ? <Reveal>{outcome}</Reveal> : null}
              {wide ? null : <div className="rv-work-inline">{work}</div>}
            </div>
          </div>
          {!wide && liveCards.length ? (
            <div className="rv-strip"><LiveStrip cards={liveCards} open={sheet} onShow={() => setSheet(true)} max={2} /></div>
          ) : null}
          {e ? <div className="rv-composer"><SteerBox run={run} e={e} /></div> : null}
        </div>
        {wide ? <aside className="rv-work" aria-label="The run's work">{work}</aside> : null}
        {!wide ? (
          <WorkSheet open={sheet && liveCards.length > 0} onClose={() => setSheet(false)}>
            <aside className="rv-work rv-work-sheet" aria-label="The run's work">
              <div className="rv-sheet-head"><span>Live work</span><button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Close live work" data-tip="Close (Esc)" onClick={() => setSheet(false)}><Icon name="close" size={15} /></button></div>
              {work}
            </aside>
          </WorkSheet>
        ) : null}
      </div>
    </div>
  );
}

async function cancel(run: Run) {
  try { await call("cancel_run", { runId: run.id }); toast("Run cancelled", "ok"); }
  catch (x) { toast(errorMessage(x), "err"); }
}

/** Which state the byline shows; a change of it swaps the word and its colour together. */
function statusKey(run: Run): string {
  return run.state === "succeeded" && run.denials.length ? "blocked" : run.state;
}

/** Where the run stands, in a word and its colour, as the conversation's byline says it: working with its minutes, up
 *  next (and when, while the usage limit holds work), blocked or failed in the colour of needs you, done. */
function StatusWord({ run }: { run: Run }) {
  const now = useNow(60_000, run.state === "running");
  const { usage } = useUsage();
  if (run.state === "running") {
    const m = minutes(elapsedMs(run, now));
    return <span className="status status-live">Working{m ? <span className="rv-status-n"><Roll value={m} /></span> : null}</span>;
  }
  if (run.state === "queued") {
    const held = usage?.heldUntil && Date.parse(usage.heldUntil) > now ? heldLabel(usage.heldUntil, new Date(now)) : null;
    return <span className="status status-wait">Up next{held ? <span className="rv-status-note">{held}</span> : null}</span>;
  }
  if (run.state === "succeeded") {
    return run.denials.length
      ? <span className="status status-attn">Blocked</span>
      : <span className="status status-ok"><Icon name="check" size={13} /> Done</span>;
  }
  if (run.state === "cancelled") return <span className="status status-plain">Cancelled</span>;
  return <span className="status status-attn">{runStateLabel(run.state)}</span>;
}

/** Where else this run lives, in the byline: the run that handed it over, the run it answered, its conversation. */
function Links({ run, e, names }: { run: Run; e: EmployeeView | undefined; names: ReturnType<typeof kindNames> }) {
  const link = (key: string, label: string, go: () => void) => (
    <span key={key} className="rv-link-wrap"><span className="rv-sep" aria-hidden>·</span><button className="rv-link" onClick={go}>{label} <Icon name="arrowUpRight" size={12} /></button></span>
  );
  const k = run.kind;
  const out: ReactNode[] = [];
  if (k.type === "delegated") out.push(link("p", `Delegated by ${names.manager ?? "their manager"}`, () => openRun(k.parentRunId)));
  if (k.type === "asked") out.push(link("p", `${k.task ? "Handed over" : "Asked"} by ${names.asker ?? "a colleague"}`, () => openRun(k.parentRunId)));
  if (k.type === "answered") out.push(link("a", "Their run", () => openRun(k.askedRunId)));
  if (k.type === "answered" && k.thread && e) out.push(link("t", "Open conversation", () => openChat(e.id, threadFocus(k.thread!))));
  if (k.type === "reply" && e) out.push(link("r", `Open ${k.task ? "conversation" : "thread"}`, () => openChat(e.id, threadFocus(k.toRunId))));
  if (k.type === "task" && e) out.push(link("c", "Open conversation", () => openChat(e.id, threadFocus(run.id))));
  return <>{out}</>;
}

/**
 * A run that did not finish: what happened, what happens next, and one way to act (Retry is in the header). A routine
 * says when it tries again on its own and, when it has failed several times running, says so.
 */
function DidNotFinish({ run, name, text }: { run: Run; name: string; text: string | null }) {
  const k = run.kind;
  const scheduleId = k.type === "scheduled" ? k.scheduleId : null;
  const history = useQuery(() => (scheduleId ? call("runs", { employeeId: run.employeeId, limit: 60 }) : Promise.resolve([])), [run.employeeId, scheduleId], ["run:updated"]);
  const schedules = useQuery(() => (scheduleId ? call("schedules", { employeeId: run.employeeId }) : Promise.resolve([])), [run.employeeId, scheduleId], ["org:changed"]);
  let streak = 1;
  if (scheduleId && history.data) {
    const same = history.data
      .filter((r) => r.kind.type === "scheduled" && r.kind.scheduleId === scheduleId && r.createdAt <= run.createdAt && r.id !== run.id && !(r.state === "running" || r.state === "queued"))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const r of same) { if (r.state === "failed" || r.state === "lost") streak += 1; else break; }
  }
  const schedule = schedules.data?.find((s) => s.id === scheduleId);
  const next = schedule?.enabled && schedule.nextFire ? `${name} tries again ${atTime(schedule.nextFire)}, or retry it now.` : `Retry it now, and ${name} carries on from where it stopped.`;
  const head = streak > 1 ? `Failed ${streak} times in a row` : run.state === "cancelled" ? "Stopped before it finished" : run.state === "lost" ? "Interrupted" : "Didn't finish";
  return (
    <section className="error-note error-note-block rv-failed" role="status">
      <Icon name="alert" size={15} />
      <div className="grow rv-failed-body">
        <div className="error-note-title">{head}</div>
        {text ? <div className="error-note-text"><Markdown text={text} /></div> : null}
        <p className="rv-next">{next}</p>
      </div>
    </section>
  );
}

/** The page's own geometry while it loads: the header, the talk and the work column. It holds still. */
function RunSkeleton() {
  return (
    <div className="runview" aria-busy aria-label="Loading">
      <header className="rv-head">
        <span className="rv-back-skel"><Skeleton h={28} w={28} r={5} /></span>
        <div className="rv-id"><Skeleton h={26} w={380} /><span className="rv-sub"><Skeleton h={20} w={20} r={10} /><Skeleton h={12} w={260} /></span></div>
      </header>
      <div className="rv-body">
        <div className="rv-talk">
          <div className="rv-inner rv-skel">
            <span className="rv-skel-quote"><Skeleton h={10} w={80} /><Skeleton h={13} w="86%" /><Skeleton h={13} w="64%" /></span>
            <span className="rv-skel-lines"><Skeleton h={13} w="92%" /><Skeleton h={13} w="78%" /><Skeleton h={13} w="55%" /></span>
          </div>
        </div>
        <aside className="rv-work rv-work-skel">
          <Skeleton h={12} w={60} />
          {[70, 52, 64, 46].map((w, i) => <span key={i} className="rv-skel-step"><Skeleton h={14} w={14} r={3} /><Skeleton h={11} w={`${w}%`} /></span>)}
        </aside>
      </div>
    </div>
  );
}

/** Your words to the run you are watching: into it while it works, into its instructions while it waits to start,
 *  and once it has finished, your reply in its thread. Either way its report or answer then waits for you in the
 *  Inbox. What went in shows on the page as it lands; a reply says where it went. It takes focus when you click or tab
 *  to it, never on load, so nothing blinks on a page you are only reading. */
function SteerBox({ run, e }: { run: Run; e: EmployeeView }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const name = firstName(e.name);
  const live = run.state === "running" || run.state === "queued";
  const placeholder = run.state === "running" ? `Message ${name}. They'll see it as they work.`
    : run.state === "queued" ? `Add to ${name}'s instructions before they start.`
    : `Reply to ${name} about this run…`;

  // Grows with what you type, as the conversation composer does.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(200, Math.max(44, el.scrollHeight))}px`;
  }, [text]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const how = await call("steer_run", { runId: run.id, text: body });
      setText("");
      if (how === "replied") {
        const open = () => openChat(e.id, threadFocus(conversationOf(run) ?? run.id));
        toast(live ? `It couldn't take messages just then, so your message went to ${name} as a reply` : `Sent to ${name} as a reply`, "ok", { label: "Open thread", run: open });
      }
    } catch (err) {
      toast(errorMessage(err), "err");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={`composer ${sending ? "composer-busy" : ""}`}>
      <textarea
        ref={input} className="composer-input" value={text} readOnly={sending} rows={1} placeholder={placeholder} aria-label={placeholder}
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={(ev) => { if (ev.key === "Enter" && !ev.shiftKey && !ev.nativeEvent.isComposing) { ev.preventDefault(); void send(); } }}
      />
      <div className="composer-bar">
        <span className="grow" />
        <span className="composer-hint rv-hint">{live ? "Their report comes to your Inbox" : "Their answer comes to your Inbox"} · Shift+Enter for a new line</span>
        <button className="btn btn-primary btn-icon btn-sm composer-send" aria-label="Send" title="Send (Enter). Shift+Enter adds a new line." disabled={sending || !text.trim()} onClick={() => void send()}>
          <Icon name="send" size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}

/** Who asked for this run, in a word or a name. */
function askedBy(run: Run, names: ReturnType<typeof kindNames>, e: EmployeeView | undefined): string {
  switch (run.kind.type) {
    case "manual": case "task": case "reply": case "chat": case "hireDecided": return "You";
    case "scheduled": return e ? `${firstName(e.name)}'s schedule` : "A schedule";
    case "delegated": return names.manager ?? "Their manager";
    case "asked": case "answered": return names.asker ?? "A colleague";
    default: return "Omega Star";
  }
}

type Fact = { k: string; label: string; value: ReactNode } | null;

/** The run's facts, one to a line. A fact that arrives while you watch (Took, Used, as a run finishes) opens its own
 *  room, so the lines below move down with it rather than jumping. */
function Facts({ facts }: { facts: Fact[] }) {
  const shown = facts.filter((f): f is NonNullable<Fact> => f !== null);
  const [first] = useState(() => new Set(shown.map((f) => f.k)));
  return (
    <div className="rv-facts">
      {shown.map((f) => {
        const row = <div className="rv-fact"><span className="rv-fact-k">{f.label}</span><span className="rv-fact-v">{f.value}</span></div>;
        return first.has(f.k) ? <div key={f.k}>{row}</div> : <Reveal key={f.k}>{row}</Reveal>;
      })}
    </div>
  );
}

/** Where a handed-over run came from: the run that asked, and what its author was working on. */
function Origin({ parentId, employees, people }: { parentId: string; employees: EmployeeView[]; people: PersonView[] }) {
  const q = useQuery(() => call("run_detail", { runId: parentId }), [parentId], ["run:updated"]);
  const p = q.data?.run;
  if (!p) return null;
  const who = employees.find((x) => x.id === p.employeeId);
  return (
    <button className="rv-origin" onClick={() => openRun(p.id)}>
      {who ? <Avatar name={who.name} hue={who.hue} size={20} /> : null}
      <span className="rv-origin-text"><span className="muted">{who ? firstName(who.name) : "They"} asked while working on</span> <b>{workLabel(p, employees, people)}</b></span>
      <Icon name="arrowUpRight" size={12} />
    </button>
  );
}

/** A run waiting to start: what it waits for, and what is ahead of it in its employee's line. */
function Waiting({ run, e, employees, people }: { run: Run; e: EmployeeView | undefined; employees: EmployeeView[]; people: PersonView[] }) {
  const { usage } = useUsage();
  const now = useNow(60_000);
  const name = e ? firstName(e.name) : "They";
  const others = (e?.live ?? []).filter((r) => r.id !== run.id);
  const working = others.filter((r) => r.state === "running");
  const ahead = others.filter((r) => r.state === "queued" && r.createdAt < run.createdAt);
  const held = usage?.heldUntil && Date.parse(usage.heldUntil) > now ? usage.heldUntil : null;
  const why = held ? `${heldLabel(held, new Date(now))}.`
    : working.length >= (e?.lanes ?? 1) ? `${name} starts this once ${working.length === 1 ? "the run below" : "one of the runs below"} finishes.`
    : ahead.length ? `${name} starts this after ${ahead.length === 1 ? "the run" : `the ${ahead.length} runs`} ahead of it.`
    : `${name} starts this as soon as they're free. Anything you add below goes into the instruction before they start.`;
  const line = [...working, ...ahead];
  const last = e?.status.lastReport;
  const next = e?.status.next;
  return (
    <section className="rv-wait" aria-label="Waiting to start">
      <span className="status status-wait">Up next</span>
      <p className="rv-wait-why">{why}</p>
      {e && (last || next) ? (
        <div className="rv-wait-list">
          <span className="rv-wait-label">Where {name} stands</span>
          {last ? <div className="rv-wait-fact"><span className="rv-wait-k">Last report</span><span className="rv-wait-v">{last.text} <span className="muted">{whenInline(last.at)}</span></span></div> : null}
          {next ? <div className="rv-wait-fact"><span className="rv-wait-k">Next on their schedule</span><span className="rv-wait-v">{next.text} <span className="muted">{whenInline(next.at)}</span></span></div> : null}
        </div>
      ) : null}
      {line.length ? (
        <div className="rv-wait-list">
          <span className="rv-wait-label">Ahead of it</span>
          {line.map((r) => (
            <button key={r.id} className="rv-wait-row" onClick={() => openRun(r.id)}>
              <span className="rv-wait-what">{workLabel(r, employees, people)}</span>
              <span className={`status ${r.state === "running" ? "status-live" : "status-wait"}`}>{r.state === "running" ? "Working" : "Up next"}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** A colleague this run handed work to, on one line (who, and where it stands) over the task. The section heading says
 *  it was handed over, so the row needn't. */
function HandRow({ childId, employeeId, task, child, employees }: { childId: string; employeeId: string; task: string; child: Run | undefined; employees: EmployeeView[] }) {
  const e = employees.find((x) => x.id === employeeId);
  const blockedChild = child?.state === "succeeded" && child.denials.length > 0;
  const word = !child ? "Asked" : child.state === "succeeded" ? (blockedChild ? "Blocked" : "Done") : runStateLabel(child.state);
  const tone = !child ? "status-plain" : child.state === "running" ? "status-live" : child.state === "queued" ? "status-wait"
    : child.state === "succeeded" ? (blockedChild ? "status-attn" : "status-ok") : child.state === "cancelled" ? "status-plain" : "status-attn";
  return (
    <button className="rv-hand" onClick={() => openRun(childId)}>
      {e ? <Avatar name={e.name} hue={e.hue} size={20} /> : <span />}
      <b className="rv-hand-who">{e ? firstName(e.name) : "Former employee"}</b>
      <span className={`status ${tone} rv-hand-state`}>{tone === "status-ok" ? <Icon name="check" size={12} /> : null}{word}</span>
      <span className="rv-hand-task">{task}</span>
    </button>
  );
}
