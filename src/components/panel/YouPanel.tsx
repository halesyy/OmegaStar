import { useMemo, useState } from "react";
import { call, errorMessage } from "../../api/client";
import type { Company } from "../../api/types";
import { firstName } from "../../lib/format";
import { refreshOrg, useDraft, useOrg, useQuery } from "../../lib/hooks";
import { toast } from "../../lib/toasts";
import { aboveYou, reportsToEffect } from "../../lib/org";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";
import { Avatar, ErrorNote, Section, Skeleton } from "../ui";
import { ImageField } from "../ImageField";
import { PageHead } from "./EmployeePanel";
import "./Panel.css";
import "../Sheet.css";

type YouDraft = Pick<Company, "name" | "ceoName" | "title" | "reportsTo" | "image">;
const draftOf = (c: Company): YouDraft => ({ name: c.name, ceoName: c.ceoName, title: c.title, reportsTo: c.reportsTo, image: c.image ?? null });

/** You on the org chart: your name, title, company and who (if anyone) you report to, then the company page. It opens
 *  with focus on your name's heading, not in a field, so reading it never invites typing over your name. */
export function YouPanel({ short, onClose }: { short: boolean; onClose: () => void }) {
  const { snap } = useOrg();
  if (!snap) return null;
  const c = snap.company;
  return (
    <section className={`mpage ${short ? "mpage-short" : ""}`} aria-label={`${c.ceoName}, ${c.title}`}>
      <PageHead av={<Avatar name={c.ceoName} hue={0} image={c.image} size={short ? 32 : 56} you />} name={c.ceoName} role={`${c.title}, you · ${c.name}`} onClose={onClose} />
      <div className="mpage-body">
        <YouProfile company={c} />
      </div>
    </section>
  );
}

function YouProfile({ company }: { company: Company }) {
  const { snap } = useOrg();
  const base = useMemo(() => draftOf(company), [company]);
  const { draft: d, set, dirty, reset } = useDraft(base);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const people = snap?.people ?? [];
  const above = snap ? aboveYou(snap) : new Set<string>();
  const effect = snap ? reportsToEffect(snap, d.reportsTo) : { error: null, agentsToYou: [] };
  const chosen = people.find((p) => p.id === d.reportsTo);
  const movesUp = chosen && !above.has(chosen.id) ? chosen : null;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await call("update_company", { name: d.name.trim(), ceoName: d.ceoName.trim(), title: d.title.trim(), reportsTo: d.reportsTo, image: d.image ?? null });
      refreshOrg();
      toast("Saved", "ok");
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fileview">
      <div className="tab-scroll">
        <Section title="About you" className="tab-form">
          <ImageField name={d.ceoName} hue={0} image={d.image} you onChange={(v) => set("image", v)} />
          <div className="form-2">
            <label className="field">
              <span className="field-label">Your name</span>
              <input className="input" value={d.ceoName} onChange={(e) => set("ceoName", e.target.value)} placeholder="Your name" />
            </label>
            <label className="field">
              <span className="field-label">Your title</span>
              <input className="input" value={d.title} onChange={(e) => set("title", e.target.value)} placeholder="CEO" />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Company</span>
            <input className="input" value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Kestrel Labs" />
          </label>
          <label className="field">
            <span className="field-label">Reports to</span>
            <select className="select" value={d.reportsTo ?? ""} onChange={(e) => set("reportsTo", e.target.value || null)}>
              <option value="">Nobody, you're at the top</option>
              {people.length ? (
                <optgroup label="People">
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.title ? ` · ${p.title}` : ""}</option>)}
                </optgroup>
              ) : null}
            </select>
            <span className="field-help">Only real people can sit above you. Every employee reports up to you.</span>
            {movesUp || effect.agentsToYou.length ? (
              <span className="field-help you-effect">
                <Icon name="org" size={12} />
                {movesUp ? `${firstName(movesUp.name)} moves above you${people.some((p) => p.manager.type === "member" && p.manager.id === movesUp.id) ? ", with the people who report to them" : ""}.` : ""}
                {effect.agentsToYou.length ? ` ${effect.agentsToYou.join(", ")} will report to you instead.` : ""}
              </span>
            ) : null}
            {!people.length ? <span className="field-help">Add a person to the org chart first if you report to someone.</span> : null}
          </label>
        </Section>
        <CompanyPageSection />
      </div>
      {dirty || err ? (
        <div className="savebar enter-rise">
          {err ? <ErrorNote text={err} /> : effect.error ? <ErrorNote text={effect.error} /> : <span className="muted" style={{ fontSize: "var(--t-sm)" }}>Unsaved changes</span>}
          <span className="grow" />
          <button className="btn btn-ghost" onClick={() => { reset(); setErr(null); }}>Discard</button>
          <button className="btn btn-primary" disabled={busy || !dirty || !d.name.trim() || !d.ceoName.trim() || !!effect.error} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        </div>
      ) : null}
    </div>
  );
}

/** The page every employee reads at the start of every run. */
function CompanyPageSection() {
  const q = useQuery(() => call("company_page"), [], ["run:updated"]);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (text === null) return;
    setBusy(true);
    setErr(null);
    try {
      q.set(await call("save_company_page", { text }));
      setText(null);
      toast("Saved", "ok");
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  const edit = text === null && q.data ? <button className="btn btn-sm" onClick={() => { setText(q.data?.text ?? ""); setErr(null); }}><Icon name="edit" size={12} /> Edit</button> : null;
  return (
    <Section title="Company page" action={edit}>
      <span className="field-help">Every employee reads this at the start of every run. They change it in a conversation with you; you can edit it here too.</span>
      {q.error ? <ErrorNote text={q.error} onRetry={q.reload} /> : null}
      {q.data === undefined && !q.error ? <Skeleton h={120} r={12} /> : null}
      {text !== null ? (
        <>
          <textarea className="textarea mono fileview-editor" value={text} onChange={(ev) => setText(ev.target.value)} spellCheck={false} autoFocus
            onKeyDown={(ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === "s") { ev.preventDefault(); void save(); } }} />
          <div className="row" style={{ gap: 8 }}>
            {err ? <ErrorNote text={err} /> : null}
            <span className="grow" />
            <button className="btn btn-ghost" onClick={() => setText(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </>
      ) : q.data ? (
        <>
          {q.data.findings.map((f) => <span key={f.kind} className="muted" style={{ fontSize: "var(--t-sm)" }}>{f.detail}</span>)}
          <div className="fileview-doc">{q.data.text.trim() ? <Markdown text={q.data.text} /> : <span className="muted">The page is empty.</span>}</div>
        </>
      ) : null}
    </Section>
  );
}
