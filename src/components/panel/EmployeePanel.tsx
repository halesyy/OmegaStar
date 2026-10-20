import { useRef, useState } from "react";
import { call, errorMessage } from "../../api/client";
import type { EmployeeView } from "../../api/types";
import { duration, elapsedMs, firstName, relTime, whenInline } from "../../lib/format";
import { useNow, useOrg } from "../../lib/hooks";
import { toast } from "../../lib/toasts";
import { openMember, openRun, openWork, type PanelTab } from "../../lib/router";
import { Conversation } from "../../screens/Conversation";
import { Icon } from "../Icon";
import { workLabel } from "../RunRow";
import { Avatar, Popover, SlideOver, Tabs } from "../ui";
import { WorkTab } from "./WorkTab";
import { SkillsTab } from "./SkillsTab";
import { ProfileTab } from "./ProfileTab";
import "./Panel.css";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "chat", label: "Chat" }, { id: "work", label: "Work" }, { id: "skills", label: "Skills" }, { id: "profile", label: "Profile" },
];

/** An employee's slide-over on the org chart: who they are, then their conversations on the Chat tab (where it
 *  opens), their Work, Skills and Profile. */
export function EmployeePanel({ employee: e, tab, focus, onClose }: { employee: EmployeeView; tab: PanelTab | null; focus: string | null; onClose: () => void }) {
  const { snap } = useOrg();
  const current = tab ?? "chat";
  const managerName = e.managerId
    ? snap?.employees.find((x) => x.id === e.managerId)?.name ?? snap?.people.find((x) => x.id === e.managerId)?.name ?? "None"
    : snap?.company.ceoName ?? "you";

  return (
    <SlideOver open onClose={onClose} label={`${e.name}, ${e.title}`}>
      <header className="panel-head">
        <Avatar name={e.name} hue={e.hue} size={44} presence={e.presence} />
        <div className="stack grow" style={{ minWidth: 0 }}>
          <h2 className="h-lg panel-name">{e.name}</h2>
          <span className="panel-sub">{e.title} · Reports to {e.managerId ? managerName : "you"}</span>
          <PresenceLine e={e} />
        </div>
        <div className="row" style={{ gap: 4, alignSelf: "flex-start" }}>
          <RunNow e={e} />
          <button className="btn btn-ghost btn-icon" aria-label="Close panel" onClick={onClose}><Icon name="close" /></button>
        </div>
      </header>
      <Tabs tabs={TABS} value={current} onChange={(t) => openMember(e.id, t, null, true)} />
      <div className="panel-body">
        {current === "chat" ? <Conversation e={e} focus={focus} variant="panel" /> : null}
        {current === "work" ? <WorkTab e={e} /> : null}
        {current === "skills" ? <SkillsTab e={e} focus={focus} /> : null}
        {current === "profile" ? <ProfileTab e={e} onGone={onClose} /> : null}
      </div>
    </SlideOver>
  );
}

/** What they are working on, one link each to where it can be followed; else what needs a look, or when they last
 *  or next work. */
function PresenceLine({ e }: { e: EmployeeView }) {
  const { snap } = useOrg();
  const now = useNow(1000, e.working > 0);
  if (e.live.length) {
    return (
      <>
        {e.live.map((run) => {
          const what = workLabel(run, snap?.employees ?? [], snap?.people ?? []);
          return (
            <button key={run.id} className="panel-presence panel-presence-accent" onClick={() => openWork(run)}>
              <span className="panel-presence-dot" />
              <span className="panel-presence-what">{run.state === "running" ? `Working on ${what}` : `Waiting to start: ${what}`}</span>
              {run.state === "running" && run.startedAt ? <><span className="faint">·</span><span className="num">{duration(elapsedMs(run, now))}</span></> : null}
              <span className="panel-presence-link"><Icon name="arrowRight" size={11} /></span>
            </button>
          );
        })}
      </>
    );
  }
  if (e.presence === "attention" && e.lastRun) {
    const reason = e.lastRun.denials.length ? "Last run was blocked" : e.lastRun.state === "lost" ? "Last run was interrupted" : "Last run failed";
    return (
      <button className="panel-presence panel-presence-warn" onClick={() => e.lastRun && openRun(e.lastRun.id)}>
        <span className="panel-presence-dot" />{reason}<span className="faint">·</span>
        <span className="panel-presence-link">Take a look <Icon name="arrowRight" size={11} /></span>
      </button>
    );
  }
  return (
    <span className="panel-presence">
      <span className="panel-presence-dot" />
      {e.nextFire ? <>Next run {whenInline(e.nextFire)}</> : e.lastWorkedAt ? <>Last worked {relTime(e.lastWorkedAt)}</> : "No runs yet"}
    </span>
  );
}

function RunNow({ e }: { e: EmployeeView }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const go = async () => {
    setBusy(true);
    try {
      const r = await call("run_now", { employeeId: e.id, instruction: text.trim() || null });
      setOpen(false);
      setText("");
      toast(r.state === "queued" && e.presence === "working" ? `Queued. ${firstName(e.name)} will start when the current run ends` : `${firstName(e.name)} is on it`, "ok", { label: "View run", run: () => openRun(r.id) });
    } catch (err) {
      toast(errorMessage(err), "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button ref={ref} className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="play" size={12} /> Run now
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={340}>
        <div className="stack" style={{ gap: 10 }} data-esc-stop>
          <label className="field">
            <span className="field-label">Anything specific? <span className="hint">optional</span></span>
            <textarea
              className="textarea" rows={3} autoFocus value={text} onChange={(ev) => setText(ev.target.value)}
              placeholder={`Leave empty and ${firstName(e.name)} does their usual work.`}
              onKeyDown={(ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); void go(); } }}
            />
          </label>
          <div className="row">
            <span className="faint" style={{ fontSize: "var(--t-sm)" }}>{e.presence === "working" ? "If they're busy with other work, this waits its turn." : "Starts right away."}</span>
            <span className="grow" />
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void go()}>Run {firstName(e.name)}</button>
          </div>
        </div>
      </Popover>
    </>
  );
}
