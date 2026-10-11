import { useMemo, useState } from "react";
import { call, errorMessage } from "../../api/client";
import type { Person, PersonView } from "../../api/types";
import { firstName } from "../../lib/format";
import { refreshOrg, useDraft, useOrg, useQuery } from "../../lib/hooks";
import { toast } from "../../lib/toasts";
import { navigate } from "../../lib/router";
import { PersonFields, personManagerName } from "../AddPersonSheet";
import { RequestCard } from "../RequestCard";
import { Icon } from "../Icon";
import { Avatar, ConfirmButton, ErrorNote, Section, SlideOver } from "../ui";
import "./Panel.css";
import "../Sheet.css";

/** A real person on the chart: who they are and how to reach them. What employees are waiting on them for lives in the Inbox. */
export function PersonPanel({ person: p, onClose }: { person: PersonView; onClose: () => void }) {
  const { snap } = useOrg();
  const manager = personManagerName(p.manager, snap);
  return (
    <SlideOver open onClose={onClose} label={`${p.name}, ${p.title}`}>
      <header className="panel-head">
        <Avatar name={p.name} hue={p.hue} size={44} person />
        <div className="stack grow" style={{ minWidth: 0 }}>
          <h2 className="h-lg panel-name">{p.name}</h2>
          <span className="panel-sub">{p.title} · {p.manager.type === "top" ? "Top of the company" : `Reports to ${manager}`}{snap?.company.reportsTo === p.id ? " · You report to them" : ""}</span>
          <span className="panel-presence"><Icon name="person" size={12} />A person, not an employee</span>
        </div>
        <button className="btn btn-ghost btn-icon" style={{ alignSelf: "flex-start" }} aria-label="Close panel" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="panel-body panel-body-ruled">
        <PersonProfile p={p} onGone={onClose} />
      </div>
    </SlideOver>
  );
}

/** Requests employees sent this person that are settled: answered, done or cancelled. Open ones are in the Inbox. */
function PastRequests({ p }: { p: PersonView }) {
  const { snap } = useOrg();
  const q = useQuery(() => call("requests", { personId: p.id, employeeId: null, state: null }), [p.id], ["request:updated", "org:changed"]);
  const closed = (q.data ?? []).filter((r) => r.state !== "open");
  if (q.error) return <ErrorNote text={q.error} onRetry={q.reload} />;
  if (!closed.length) return null;
  return (
    <Section title="Past requests" count={closed.length}>
      <div className="stack" style={{ gap: 8 }}>
        {closed.map((r) => <RequestCard key={r.id} r={r} employee={snap?.employees.find((e) => e.id === r.employeeId)} person={p} />)}
      </div>
    </Section>
  );
}

function toPerson(v: PersonView): Person {
  const { openRequests: _, ...person } = v;
  return person;
}

function PersonProfile({ p, onGone }: { p: PersonView; onGone: () => void }) {
  const base = useMemo(() => toPerson(p), [p]);
  const { draft: d, setDraft, dirty, reset } = useDraft(base);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = firstName(p.name);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await call("update_person", { person: { ...d, channels: d.channels.filter((c) => c.address.trim()) } });
      refreshOrg();
      toast("Saved", "ok");
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await call("remove_person", { personId: p.id });
      refreshOrg();
      toast(`${name} is no longer in the org chart`, "ok");
      onGone();
    } catch (x) {
      toast(errorMessage(x), "err");
    }
  };
  return (
    <div className="fileview">
      <div className="tab-scroll">
        {p.openRequests > 0 ? (
          <div className="person-waiting">
            <Icon name="ask" size={14} />
            <span>{p.openRequests === 1 ? `An employee is waiting on ${name}` : `${p.openRequests} requests are waiting on ${name}`}</span>
            <button className="btn btn-sm" onClick={() => navigate({ page: "inbox" })}>Open Inbox</button>
          </div>
        ) : null}
        <div className="stack" style={{ gap: 18 }}>
          <PersonFields draft={d} set={(k, v) => setDraft((x) => ({ ...x, [k]: v }))} selfId={p.id} />
          <PastRequests p={p} />
          <div className="danger">
            <div className="stack grow">
              <span className="danger-title">Remove {name} from the org chart</span>
              <span className="danger-desc">Their reports move up a level and open requests to them are cancelled.</span>
            </div>
            <ConfirmButton label="Remove" className="btn btn-danger" size="btn-sm" question={`Remove ${name}?`} confirmLabel="Remove" onConfirm={remove} />
          </div>
        </div>
      </div>
      {dirty || err ? (
        <div className="savebar">
          {err ? <ErrorNote text={err} /> : <span className="muted" style={{ fontSize: "var(--t-sm)" }}>Unsaved changes</span>}
          <span className="grow" />
          <button className="btn btn-ghost" onClick={() => { reset(); setErr(null); }}>Discard</button>
          <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        </div>
      ) : null}
    </div>
  );
}
