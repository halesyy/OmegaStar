import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { call, errorMessage } from "../api/client";
import type { EmployeeView, Run } from "../api/types";
import { mcpServerName, mcpServerRule, toolName } from "../lib/rules";
import { dateLong, duration, elapsedMs, firstName, runKindLabel, runStateLabel, runStateTone } from "../lib/format";
import { refreshOrg, useNow, useOrg, useProposals, useQuery, useRunDetail } from "../lib/hooks";
import { toast } from "../lib/toasts";
import { navigate, openChat, openMember, openRun } from "../lib/router";
import { conversationOf, threadFocus } from "../lib/threads";
import { kindNames } from "../components/RunRow";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { SubAgents } from "../components/SubAgents";
import { Visual } from "../components/Visual";
import { TidyProposal } from "../components/TidyProposal";
import { DelegatedCard, ProposedRow, RequestedRow, SkillChip, ToolRows, toItems } from "../components/Transcript";
import { Avatar, ConfirmButton, ErrorNote, Skeleton, StatePill } from "../components/ui";
import "../components/panel/ChatTab.css";
import "./RunView.css";

export function RunView({ runId }: { runId: string }) {
  const { detail, error, reload } = useRunDetail(runId);
  const { snap } = useOrg();
  const run = detail?.run;
  const live = run?.state === "running" || run?.state === "queued";
  const now = useNow(1000, !!live);
  const e = snap?.employees.find((x) => x.id === run?.employeeId);
  const requests = useQuery(() => (run ? call("requests", { personId: null, employeeId: run.employeeId, state: null }) : Promise.resolve([])), [run?.employeeId], ["request:updated"]);
  const proposals = useProposals();
  const items = useMemo(() => toItems(detail?.events ?? []), [detail?.events]);
  const back = () => (history.length > 1 ? history.back() : navigate({ page: "org", memberId: null, tab: null, focus: null }));

  if (error) {
    return (
      <div className="runview"><div className="runview-inner">
        <div className="empty runview-missing">
          <Icon name="activity" size={22} />
          <span className="empty-title">That run could not be found</span>
          <p>{/not.?found|could not be found/i.test(error) ? "The link may be out of date, or the run belonged to someone who has left." : error}</p>
          <div className="row">
            <button className="btn btn-ghost" onClick={back}><Icon name="arrowLeft" size={13} /> Back</button>
            <button className="btn" onClick={reload}>Try again</button>
          </div>
        </div>
      </div></div>
    );
  }
  if (!detail || !run) {
    return (
      <div className="runview"><div className="runview-inner stack" style={{ gap: 14 }}>
        <Skeleton h={28} w={260} /><Skeleton h={18} w={380} /><Skeleton h={120} r={12} /><Skeleton h={60} r={12} />
      </div></div>
    );
  }

  const names = kindNames(run, snap?.employees ?? [], snap?.people ?? []);
  const label = runKindLabel(run.kind, names);
  const tone = runStateTone(run);
  const result = [...items].reverse().find((i) => i.kind === "result");
  // Once its transcript is gone, the report kept on the run stands in for the last result.
  const report = result?.kind === "result" ? result : detail.transcriptGone && run.summary ? { ok: run.state === "succeeded", text: run.summary } : null;
  const cancel = async () => {
    try { await call("cancel_run", { runId: run.id }); toast("Run cancelled", "ok"); }
    catch (x) { toast(errorMessage(x), "err"); }
  };

  return (
    <div className="runview">
      <div className="runview-inner">
      <header className="runview-head">
          <button className="btn btn-ghost btn-sm runview-back" onClick={back}><Icon name="arrowLeft" size={13} /> Back</button>
          <div className="runview-title">
            {e ? <Avatar name={e.name} hue={e.hue} size={40} presence={live ? "working" : undefined} /> : null}
            <div className="stack grow" style={{ minWidth: 0 }}>
              <span className="runview-who">
                {e ? <button className="linkish" onClick={() => openMember(e.id, "work")}>{e.name}</button> : "Former employee"}
                <span className="faint"> · {e?.title}</span>
              </span>
              <h1 className="h-lg runview-label">{label}</h1>
            </div>
            <StatePill tone={tone} pulse={live}>{run.state === "succeeded" && run.denials.length ? "Done, something was blocked" : runStateLabel(run.state)}</StatePill>
            {live ? <ConfirmButton label="Cancel" icon="stop" className="btn" size="btn-sm" question="Stop this run?" confirmLabel="Stop it" onConfirm={cancel} /> : null}
          </div>
          <div className="runview-stats">
            <span>{run.startedAt ? dateLong(run.startedAt) : "Waiting to start"}</span>
            {run.startedAt ? <span className="num">{live ? "running for" : "took"} {duration(elapsedMs(run, now))}</span> : null}
            {run.kind.type === "delegated" || run.kind.type === "asked" ? <button className="runview-parent" onClick={() => (run.kind.type === "delegated" || run.kind.type === "asked") && openRun(run.kind.parentRunId)}>The run that asked <Icon name="arrowUpRight" size={12} /></button> : null}
            {run.kind.type === "answered" ? <button className="runview-parent" onClick={() => run.kind.type === "answered" && openRun(run.kind.askedRunId)}>Their run <Icon name="arrowUpRight" size={12} /></button> : null}
            {run.kind.type === "answered" && run.kind.thread && e ? <button className="runview-parent" onClick={() => run.kind.type === "answered" && run.kind.thread && openChat(e.id, threadFocus(run.kind.thread))}>Open conversation <Icon name="arrowUpRight" size={12} /></button> : null}
            {run.kind.type === "reply" && e ? <button className="runview-parent" onClick={() => run.kind.type === "reply" && openChat(e.id, threadFocus(run.kind.toRunId))}>Open {run.kind.task ? "conversation" : "thread"} <Icon name="arrowUpRight" size={12} /></button> : null}
            {run.kind.type === "task" && e ? <button className="runview-parent" onClick={() => openChat(e.id, threadFocus(run.id))}>Open conversation <Icon name="arrowUpRight" size={12} /></button> : null}
          </div>
      </header>
      <div className="runview-body">
          <section className="rv-prompt">
            <span className="rv-prompt-label">{run.kind.type === "followUp" ? "Picked up with" : run.kind.type === "delegated" ? `From ${names.manager ?? "their manager"}` : run.kind.type === "asked" ? `${names.asker ?? "A colleague"} ${run.kind.task ? "handed over" : "asked"}` : run.kind.type === "answered" ? `${names.asker ?? "A colleague"} got back to them` : "Instruction"}</span>
            <p>{run.prompt}</p>
          </section>
          <SubAgents tasks={detail.tasks} runActive={!!live} />
          {detail.transcriptGone ? <p className="muted" style={{ fontSize: "var(--t-sm)" }}>This run's transcript is no longer kept.</p> : null}
          <div className="rv-events">
            {items.map((it) => {
              switch (it.kind) {
                case "user": return <section key={it.key} className="rv-prompt"><span className="rv-prompt-label">You added</span><p>{it.text}</p></section>;
                case "init": return <div key={it.key} className="rv-init mono"><Icon name="play" size={11} /> Started on {it.model} · {it.skills.length} skills available</div>;
                // The closing message is the report, shown once below rather than twice.
                case "text": return result?.kind === "result" && result.text?.trim() === it.text.trim() ? null : <Markdown key={it.key} text={it.text} />;
                case "tools": return <ToolRows key={it.key} tools={it.tools} running={!!live} tasks={detail.tasks} />;
                case "skill": return <SkillChip key={it.key} skill={it.skill} file={it.file} change={it.change} onClick={e ? () => openMember(e.id, "skills", `diff~${run.id}~${it.skill}~${it.file}`) : undefined} />;
                case "delegated": return <DelegatedCard key={it.key} childRunId={it.childRunId} employeeId={it.employeeId} task={it.task} asked={it.asked} handoff={it.handoff} employees={snap?.employees ?? []} child={detail.children.find((c) => c.id === it.childRunId)} />;
                case "requested": return <RequestedRow key={it.key} personId={it.personId} reqKind={it.reqKind} message={it.message} people={snap?.people ?? []} request={requests.data?.find((r) => r.id === it.requestId)} />;
                case "proposed": return <ProposedRow key={it.key} name={it.name} title={it.title} proposal={proposals?.find((p) => p.id === it.proposalId)} />;
                case "visual": return <Visual key={it.key} runId={run.id} id={it.id} title={it.title} />;
                case "stderr": return <pre key={it.key} className="rv-stderr mono">{it.text}</pre>;
                case "result": return null;
              }
            })}
            {detail.live ? <Markdown text={detail.live} className="md-live" /> : null}
            {live && !detail.live ? <span className="thinking"><span /><span /><span /></span> : null}
          </div>
          {run.denials.length && e ? <Denials run={run} e={e} /> : null}
          <TidyProposal run={run} employee={e} />
          {report ? (
            <section className={`rv-result ${report.ok ? "" : "rv-result-err"}`}>
              <div className="rv-result-head">
                <Icon name={report.ok ? "checkCircle" : "alert"} size={15} />
                <span>{report.ok ? "Report" : "Didn't finish"}</span>
                <span className="grow" />
                <span className="num faint">{duration(elapsedMs(run))}</span>
              </div>
              {report.text ? <Markdown text={report.text} /> : <p className="muted">No report.</p>}
              {run.skillChanges.length ? (
                <div className="rv-grew">
                  <Icon name="sparkle" size={13} /> {e ? firstName(e.name) : "They"} changed {run.skillChanges.length} {run.skillChanges.length === 1 ? "skill" : "skills"} during this run.
                </div>
              ) : null}
            </section>
          ) : !live && run.error ? <ErrorNote text={run.error} /> : null}
          {detail.children.length ? (
            <section className="rv-children">
              <h2 className="rv-section-title">{detail.children.every((c) => c.kind.type === "asked") ? "Asked of colleagues" : detail.children.some((c) => c.kind.type === "asked") ? "Handed to colleagues and asked" : "Handed to colleagues"}</h2>
              {detail.children.map((c) => <ChildRow key={c.id} c={c} employees={snap?.employees ?? []} />)}
            </section>
          ) : null}
      </div>
      {e ? <SteerBox run={run} e={e} autoFocus={!!live} /> : null}
      </div>
    </div>
  );
}

/** Your words to the run you are watching: into it while it works, into its instructions while it waits to start,
 *  and once it has finished, your reply in its thread. Either way its report or answer then waits for you in the
 *  Inbox. What went in shows on the page as it lands; a reply says where it went. `autoFocus`: the run was working or
 *  waiting when the page opened, so the box is ready to type in. */
function SteerBox({ run, e, autoFocus }: { run: Run; e: EmployeeView; autoFocus: boolean }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const name = firstName(e.name);
  const live = run.state === "running" || run.state === "queued";
  const placeholder = run.state === "running" ? `Message ${name}. They'll see it as they work.`
    : run.state === "queued" ? `Add to ${name}'s instructions before they start.`
    : `Reply to ${name} about this run…`;

  useEffect(() => { if (autoFocus) input.current?.focus({ preventScroll: true }); }, [autoFocus]);

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
    <div className="rv-steer">
      <div className={`composer ${sending ? "composer-busy" : ""}`}>
        <textarea
          ref={input} className="composer-input" value={text} readOnly={sending} rows={1} placeholder={placeholder} aria-label={placeholder}
          onChange={(ev) => setText(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === "Enter" && !ev.shiftKey && !ev.nativeEvent.isComposing) { ev.preventDefault(); void send(); } }}
        />
        <div className="composer-bar">
          <span className="grow" />
          <span className="composer-hint faint">{live ? "Their report comes to your Inbox" : "Their answer comes to your Inbox"} · Shift+Enter for a new line</span>
          <button className="btn btn-primary btn-icon btn-sm composer-send" aria-label="Send" title="Send (Enter). Shift+Enter adds a new line." disabled={sending || !text.trim()} onClick={() => void send()}>
            <Icon name="send" size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ChildRow({ c, employees }: { c: Run; employees: EmployeeView[] }) {
  const e = employees.find((x) => x.id === c.employeeId);
  return (
    <button className="rv-child" onClick={() => openRun(c.id)}>
      {e ? <Avatar name={e.name} hue={e.hue} size={24} presence={c.state === "running" ? "working" : undefined} /> : null}
      <span className="grow" style={{ minWidth: 0 }}><b>{e?.name ?? "Former employee"}</b> <span className="muted">{c.prompt}</span></span>
      <StatePill tone={runStateTone(c)} pulse={c.state === "running"}>{runStateLabel(c.state)}</StatePill>
    </button>
  );
}

function Denials({ run, e }: { run: Run; e: EmployeeView }) {
  const [allowed, setAllowed] = useState<Set<string>>(() => new Set(run.denials.flatMap((d) => [d.suggestedRule, mcpServerRule(d.tool) ?? ""]).filter((r) => r && e.allowRules.includes(r))));
  const allow = async (rule: string) => {
    try {
      await call("allow_rule", { employeeId: e.id, rule });
      setAllowed(new Set(allowed).add(rule));
      refreshOrg();
      toast(`${firstName(e.name)} can now use ${rule} without asking`, "ok");
    } catch (x) {
      toast(errorMessage(x), "err");
    }
  };
  return (
    <section className="rv-denials">
      <div className="rv-denials-head"><Icon name="shield" size={14} /> {run.denials.length === 1 ? "One action was blocked" : `${run.denials.length} actions were blocked`}</div>
      <p className="muted" style={{ fontSize: "var(--t-sm)" }}>{firstName(e.name)} is supervised, so anything you haven't allowed is blocked. Allow it here and it isn't blocked next time.</p>
      {run.denials.map((d, i) => {
        const server = mcpServerRule(d.tool);
        const covered = allowed.has(d.suggestedRule) || (server !== null && allowed.has(server));
        return (
          <div key={i} className="rv-denial">
            <div className="stack grow" style={{ minWidth: 0 }}>
              <span className="rv-denial-what"><b className="mono">{toolName(d.tool)}</b>{mcpServerName(d.tool) ? <span className="pill">{mcpServerName(d.tool)}</span> : null}</span>
              <span className="mono rv-denial-brief" title={`Rule: ${d.suggestedRule}`}>{d.brief}</span>
            </div>
            {covered ? (
              <span className="pill pill-ok"><Icon name="check" size={11} /> Allowed</span>
            ) : (
              <span className="row" style={{ gap: 6, flex: "none" }}>
                <button className="btn btn-sm" onClick={() => void allow(d.suggestedRule)}>Allow from now on</button>
                {server ? <button className="btn btn-sm" onClick={() => void allow(server)} title={`Every tool of ${mcpServerName(d.tool)}: ${server}`}>Allow all {mcpServerName(d.tool)} tools</button> : null}
              </span>
            )}
          </div>
        );
      })}
    </section>
  );
}
