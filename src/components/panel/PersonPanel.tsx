import { useMemo, useState } from "react";
import { call, errorMessage } from "../../api/client";
import type { HumanRequest, Person, PersonView } from "../../api/types";
import { firstName } from "../../lib/format";
import { refreshOrg, useDraft, useOrg, useQuery, type Query } from "../../lib/hooks";
import { toast } from "../../lib/toasts";
import { PersonFields, personManagerName } from "../AddPersonSheet";
import { RequestCard } from "../RequestCard";
import { Avatar, ConfirmButton, ErrorNote, Section } from "../ui";
import { PageHead } from "./EmployeePanel";
import "./Panel.css";
import "../Sheet.css";

/** A real person on the chart: who they are and how to reach them. When employees are waiting on them, the band says
 *  who; what they asked, and Answer, are said once, in the requests that lead the page. */
export function PersonPanel({ person: p, short, onClose }: { person: PersonView; short: boolean; onClose: () => void }) {
  const { snap } = useOrg();
  const manager = personManagerName(p.manager, snap);
  const reqs = useQuery(() => call("requests", { personId: p.id, employeeId: null, state: null }), [p.id], ["request:updated", "org:changed"]);
  const open = (reqs.data ?? []).filter((r) => r.state === "open");
  const role = `${p.title}${p.title ? " · " : ""}${p.manager.type === "top" ? "Top of the company" : `Reports to ${manager}`}${snap?.company.reportsTo === p.id ? " · You report to them" : ""}`;
  return (
    <section className={`mpage ${short ? "mpage-short" : ""}`} aria-label={`${p.name}, ${p.title}`}>
      <PageHead
        av={<Avatar name={p.name} hue={p.hue} size={short ? 32 : 56} person />}
        name={p.name} role={<>{role} <span className="tag">Person</span></>} onClose={onClose}
      />
      {open.length ? <PersonBand p={p} open={open} /> : null}
      <div className="mpage-body">
        <PersonProfile p={p} reqs={reqs} onGone={onClose} />
      </div>
    </section>
  );
}

/** Who is waiting on them ("Mae and Theo are waiting on Kofi"). The requests right below carry the words and the
 *  Answer buttons, so the band has none of its own. */
function PersonBand({ p, open }: { p: PersonView; open: HumanRequest[] }) {
  const { snap } = useOrg();
  const name = firstName(p.name);
  const who = [...new Set(open.map((r) => snap?.employees.find((e) => e.id === r.employeeId)?.name).filter(Boolean).map((n) => firstName(n as string)))];
  const others = open.length - who.length;
  const names = who.length === 0 ? `${open.length} ${open.length === 1 ? "employee" : "employees"}`
    : who.length === 1 ? who[0] + (others > 0 ? ` and ${others} more` : "")
    : `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}`;
  const many = open.length > 1 || who.length > 1;
  return (
    <div className="band band-person band-warn">
      <div className="band-left">
        <span className="band-text"><b className="band-word">{names}</b> {many ? "are" : "is"} waiting on {name}</span>
      </div>
    </div>
  );
}

/** Requests employees sent this person: the open ones lead the page, the settled ones (answered, done, cancelled)
 *  come after their details. */
function Requests({ p, reqs, open }: { p: PersonView; reqs: Query<HumanRequest[]>; open: boolean }) {
  const { snap } = useOrg();
  const list = (reqs.data ?? []).filter((r) => (r.state === "open") === open);
  if (reqs.error) return open ? <ErrorNote text={reqs.error} onRetry={reqs.reload} /> : null;
  if (!list.length) return null;
  return (
    <Section title={open ? `Waiting on ${firstName(p.name)}` : "Past requests"} count={list.length} id={open ? `waiting-${p.id}` : undefined}>
      <div className="stack" style={{ gap: 8 }}>
        {list.map((r) => <RequestCard key={r.id} r={r} employee={snap?.employees.find((e) => e.id === r.employeeId)} person={p} onChanged={() => reqs.reload()} />)}
      </div>
    </Section>
  );
}

function toPerson(v: PersonView): Person {
  const { openRequests: _, ...person } = v;
  return person;
}

function PersonProfile({ p, reqs, onGone }: { p: PersonView; reqs: Query<HumanRequest[]>; onGone: () => void }) {
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
        <Requests p={p} reqs={reqs} open />
        <Section title={`About ${name}`} className="tab-form">
          <PersonFields draft={d} set={(k, v) => setDraft((x) => ({ ...x, [k]: v }))} selfId={p.id} />
        </Section>
        <Requests p={p} reqs={reqs} open={false} />
        <div className="psec">
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
        <div className="savebar enter-rise">
          {err ? <ErrorNote text={err} /> : <span className="muted" style={{ fontSize: "var(--t-sm)" }}>Unsaved changes</span>}
          <span className="grow" />
          <button className="btn btn-ghost" onClick={() => { reset(); setErr(null); }}>Discard</button>
          <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        </div>
      ) : null}
    </div>
  );
}
