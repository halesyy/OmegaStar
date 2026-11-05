// The shared parts, rendered from the real components and CSS: `npm run dev`, then /?preview=parts (add &theme=dark).
// Dev only, like the rest of src/preview: main.tsx loads it behind import.meta.env.DEV, so builds never contain it.
// Every name and figure is invented (the Fernbrook office of office.ts).
import { useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { Avatar, ErrorNote, Roll, Skeleton, StatePill, Switch, Tabs } from "../components/ui";
import { useFlip } from "../lib/motion";
import { setTheme } from "../lib/theme";

const H = { juniper: 186, otto: 22, theo: 40, rafi: 150, kofi: 170, noor: 12, mae: 330, ines: 270 };

function Sec({ title, note, span = 4, children }: { title: string; note?: string; span?: number; children: ReactNode }) {
  return (
    <section className="pt-sec" style={{ gridColumn: `span ${span}` }}>
      <h2 className="pt-h">{title}{note ? <span>{note}</span> : null}</h2>
      {children}
    </section>
  );
}
const Row = ({ label, children }: { label?: string; children: ReactNode }) => (
  <div className="pt-row">{label ? <span className="pt-lab">{label}</span> : null}{children}</div>
);

export function Parts() {
  const q = new URLSearchParams(location.search).get("theme");
  if (q === "dark" || q === "light") setTheme(q);
  const [tab, setTab] = useState<"chat" | "work" | "skills" | "profile">("chat");
  const [seg, setSeg] = useState("everyone");
  const [on, setOn] = useState(true);
  const [count, setCount] = useState(16);
  const [cost, setCost] = useState(2.94);
  const [rows, setRows] = useState(["otto", "rafi", "mae"]);
  const [open, setOpen] = useState(true);
  const list = useFlip<HTMLDivElement>(rows.join());

  return (
    <div className="pt">
      <style>{CSS}</style>
      <header className="pt-top">
        <h1 className="h-xl">Shared parts</h1>
        <p className="muted">Every part the screens reuse, from the real components. Light and dark come from the same tokens.</p>
      </header>
      <div className="pt-grid">
        <Sec title="Buttons" note="32 px; 28 px small; one primary per view">
          <Row label="Primary"><button className="btn btn-primary"><Icon name="plus" size={14} /> Hire</button><button className="btn btn-primary" disabled>Disabled</button></Row>
          <Row label="Secondary"><button className="btn">Decline</button><button className="btn"><Icon name="play" size={12} /> Run now</button><button className="btn btn-sm">Small</button></Row>
          <Row label="Quiet"><button className="btn btn-ghost"><Icon name="clock" size={14} /> Later<span className="kc">L</span></button><button className="btn btn-ghost"><Icon name="userPlus" size={14} /> Add person</button><button className="btn btn-ghost btn-icon" aria-label="More"><Icon name="more" size={14} /></button></Row>
          <Row label="Danger"><button className="btn btn-danger">Remove from the org</button><button className="btn btn-danger-solid">Remove Ines</button></Row>
          <p className="pt-cap">Danger asks first; the solid one is the confirm.</p>
        </Sec>

        <Sec title="Inputs">
          <label className="field"><span className="field-label">Title</span><input className="input" defaultValue="Content Writer" /><span className="field-help">What they do, in two or three words.</span></label>
          <label className="field"><span className="field-label">Works in <span className="hint">optional</span></span><input className="input mono" defaultValue="~/Fernbrook/marketing/blog" autoFocus /></label>
          <label className="field"><span className="field-label">Reports to</span><input className="input" placeholder="Choose a manager" aria-invalid /><span className="field-error"><Icon name="alert" size={12} /> Everyone reports to someone. Pick Theo or you.</span></label>
          <label className="field"><span className="field-label">Objective</span><textarea className="textarea" rows={2} defaultValue="Publish one useful post a week that studios find through search." /></label>
        </Sec>

        <Sec title="Segmented, tabs, switch">
          <div className="seg">
            {["everyone", "employees", "people"].map((s) => <button key={s} aria-pressed={seg === s} onClick={() => setSeg(s)}>{s[0].toUpperCase() + s.slice(1)}</button>)}
          </div>
          <Tabs className="pt-tabs" value={tab} onChange={setTab} tabs={[{ id: "chat", label: "Chat" }, { id: "work", label: "Work" }, { id: "skills", label: "Skills", badge: 1 }, { id: "profile", label: "Profile" }]} />
          <Row><Switch checked={on} onChange={setOn} label="Ask before sending email" /><span>Ask before sending email</span></Row>
          <Row><Switch checked={false} onChange={() => {}} label="Run on a schedule" disabled /><span className="muted">Run on a schedule</span></Row>
          <p className="pt-cap">The chosen option is a solid inverted block in light and a raised step in dark.</p>
        </Sec>

        <Sec title="Chips, tags, keys">
          <Row><button className="chip" aria-pressed>All <span className="n">16</span></button><button className="chip">Decide <span className="n">5</span></button><button className="chip">Approve <span className="n">3</span></button><button className="chip">Do <span className="n">2</span></button></Row>
          <Row><span className="tag tag-hire">Hire</span><span className="tag">Decide</span><span className="tag">Approve</span><span className="tag">Answer</span><span className="tag tag-attn">Failed</span><span className="tag tag-live">Working</span><span className="tag tag-warn">Not installed</span></Row>
          <Row><span className="kbd">⌘ K</span><span className="kbd">J</span><span className="kbd">K</span><span className="kbd">esc</span></Row>
          <p className="pt-cap">Chips filter and are round; tags label and are square.</p>
        </Sec>

        <Sec title="Menu, tooltip, toasts">
          <div className="pt-pair">
            <div className="popover pt-static" style={{ width: 232 }}>
              <div className="menu" role="menu">
                <button className="menu-item"><Icon name="clock" size={13} /> Change schedule</button>
                <button className="menu-item pt-hover"><Icon name="teach" size={13} /> Teach a skill <span className="kbd">T</span></button>
                <button className="menu-item"><Icon name="stop" size={13} /> Pause</button>
                <div className="menu-sep" />
                <button className="menu-item menu-item-danger"><Icon name="close" size={13} /> Remove from the org</button>
              </div>
            </div>
            <span className="pt-tipdemo"><button className="btn btn-ghost btn-icon" data-tip="Fit to view"><Icon name="fit" size={14} /></button><span className="tip tip-on pt-static">Fit to view</span></span>
          </div>
          <div className="pt-toasts">
            <div className="toast toast-ok pt-static"><Icon name="checkCircle" size={14} /><span>Sent to Otto: upgrade Saturday night.</span><button className="toast-action">Undo</button></div>
            <div className="toast toast-err pt-static"><Icon name="alert" size={14} /><span>Couldn't reach staging. Rafi tries again at 1:00 am.</span><button className="toast-close" aria-label="Dismiss"><Icon name="close" size={13} /></button></div>
          </div>
        </Sec>

        <Sec title="Avatars" note="initials on the cap height">
          <Row>
            <figure className="pt-av"><Avatar name="Juniper Hale" hue={H.juniper} size={48} /><figcaption>Employee</figcaption></figure>
            <figure className="pt-av"><Avatar name="Kofi Mensah" hue={H.kofi} size={48} person /><figcaption>Person</figcaption></figure>
            <figure className="pt-av"><Avatar name="Noor Haddad" hue={H.noor} size={48} proposed /><figcaption>Proposed hire</figcaption></figure>
            <figure className="pt-av"><Avatar name="Maren Holt" hue={0} size={48} you /><figcaption>You</figcaption></figure>
          </Row>
          <Row>
            {[32, 28, 24, 20, 18].map((s) => <Avatar key={s} name="Otto Lindqvist" hue={H.otto} size={s} />)}
            <Avatar name="Juniper Hale" hue={H.juniper} size={24} presence="working" />
            <Avatar name="Theo Marchetti" hue={H.theo} size={24} presence="attention" />
            <Avatar name="Rafi Mendel" hue={H.rafi} size={24} presence="queued" />
          </Row>
          <p className="pt-cap">A dot sits on the avatar only where there is no room for a word. It holds still.</p>
        </Sec>

        <Sec title="Status" note="a word first; colour says the same thing; nothing pulses" span={8}>
          <div className="pt-status">
            <span className="pt-lab">Working</span><StatePill tone="accent">Working</StatePill><span className="status status-live">Working, 3 min</span><span className="dot dot-live" />
            <span className="pt-lab">Waiting</span><StatePill tone="wait">Up next</StatePill><span className="status status-wait">Up next: booking widget</span><span className="dot dot-wait" />
            <span className="pt-lab">Needs you</span><StatePill tone="err">Needs your OK</StatePill><span className="status status-attn">Needs your OK</span><span className="dot dot-attn" />
            <span className="pt-lab">Failed</span><span className="pill pill-err"><Icon name="alert" size={12} />Last run failed</span><span className="status status-fail">Last run failed</span><span className="dot dot-attn" />
            <span className="pt-lab">Done</span><span className="pill pill-ok"><Icon name="check" size={12} />Done</span><span className="status status-ok"><Icon name="check" size={12} />Otto reported back</span><span className="dot dot-ok" />
          </div>
          <p className="pt-cap">Ultramarine means working; coral means it needs you or failed; green only for done.</p>
        </Sec>

        <Sec title="Motion" note="state changes only; reduced motion crossfades">
          <Row label="Roll"><button className="btn btn-sm" onClick={() => setCount((c) => c - 1)}>Settle one</button><button className="btn btn-sm" onClick={() => setCount((c) => c + 1)}>Add one</button><span className="side-badge-demo num"><Roll value={count} /></span></Row>
          <Row label="Amount"><button className="btn btn-sm" onClick={() => setCost((c) => Math.round((c + 0.37) * 100) / 100)}>Add a run</button><span className="num pt-amount"><Roll value={"$" + cost.toFixed(2)} /></span></Row>
          <Row label="Move"><button className="btn btn-sm" onClick={() => setRows((r) => [...r.slice(1), r[0]])}>Reorder</button><button className="btn btn-sm" onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Open"} a row</button></Row>
          <div ref={list} className="pt-list">
            {rows.map((r) => <div key={r} data-key={r} className="pt-li"><Avatar name={r} hue={H[r as keyof typeof H]} size={22} /><span>{r[0].toUpperCase() + r.slice(1)}</span></div>)}
            <div className="collapse" data-open={open}><div><div className="pt-li"><Avatar name="Ines Duarte" hue={H.ines} size={22} /><span>Ines</span></div></div></div>
          </div>
        </Sec>

        <Sec title="Slide-over sheet" note="flush with the right edge, over a scrim" span={6}>
          <div className="pt-frame">
            <div className="pt-under"><Skeleton h={10} w="40%" /><Skeleton h={10} w="70%" /><Skeleton h={10} w="55%" /></div>
            <div className="scrim scrim-on pt-abs" />
            <aside className="slideover slideover-modal slideover-on pt-sheet">
              <header className="sheet-head"><div><h2 className="h-lg">Hire an employee</h2><p className="muted">An agent on your Claude Code who works on their own.</p></div><button className="btn btn-ghost btn-icon" aria-label="Close"><Icon name="close" /></button></header>
              <div className="sheet-body" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
                <div className="sheet-form">
                  <label className="field"><span className="field-label">Name</span><input className="input" defaultValue="Noor Haddad" /></label>
                  <label className="field"><span className="field-label">Title</span><input className="input" defaultValue="Content Writer" /></label>
                </div>
              </div>
              <footer className="sheet-foot"><span className="faint">You can change all of this later.</span><span className="grow" /><button className="btn btn-ghost">Cancel</button><button className="btn btn-primary"><Icon name="userPlus" size={14} /> Hire Noor</button></footer>
            </aside>
          </div>
        </Sec>

        <Sec title="Command palette" note="⌘ K from anywhere" span={6}>
          <div className="pt-frame pt-palframe">
            <div className="palette pt-static">
              <div className="palette-input"><Icon name="search" size={16} /><input defaultValue="price" readOnly /></div>
              <div className="palette-list">
                <div className="palette-group">Skills</div>
                <button className="palette-item" aria-selected><span className="pi-icon"><Icon name="layers" size={16} /></span><span className="pi-label mono"><mark>price</mark>-changes</span><span className="pi-hint">Juniper</span></button>
                <div className="palette-group">Runs</div>
                <button className="palette-item"><span className="pi-icon"><Icon name="chat" size={16} /></span><span className="pi-label">March <mark>price</mark> change plan</span><span className="pi-hint">Juniper · 31m ago</span></button>
              </div>
              <div className="palette-foot"><span><span className="kbd">↑</span><span className="kbd">↓</span> move</span><span><span className="kbd">↵</span> open</span><span><span className="kbd">esc</span> close</span></div>
            </div>
          </div>
        </Sec>

        <Sec title="Empty" note="what this is for, then one way to start">
          <div className="empty pt-box">
            <div className="empty-title">Nothing waiting on you</div>
            <p>When an employee needs a decision, an answer or a hand, it lands here.</p>
            <div className="empty-actions"><button className="btn btn-sm">Open the org chart</button></div>
          </div>
        </Sec>

        <Sec title="Loading" note="at the content's own geometry; it holds still">
          <div className="pt-skel">
            {[62, 48, 70].map((w) => (
              <div key={w} className="pt-skrow"><Skeleton h={28} w={28} r={14} /><div className="stack" style={{ gap: 7, flex: 1 }}><Skeleton h={10} w={`${w}%`} /><Skeleton h={8} w={`${w - 22}%`} /></div><Skeleton h={10} w={28} /></div>
            ))}
          </div>
        </Sec>

        <Sec title="Error" note="what happened, what happens next, one way to act">
          <ErrorNote title="Couldn't load the org chart" text="Omega Star's service didn't answer. Your team keeps working." onRetry={() => {}} />
          <ErrorNote text="Couldn't save: the name is already taken." />
        </Sec>
      </div>
    </div>
  );
}

const CSS = `
body { overflow: auto; }
.pt { width: 1600px; padding: 44px 48px 56px; background: var(--canvas); min-height: 100%; }
.pt-top { display: flex; align-items: baseline; gap: 16px; padding-bottom: 28px; border-bottom: 1px solid var(--line); }
.pt-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); column-gap: 48px; }
.pt-sec { padding: 28px 0 32px; border-bottom: 1px solid var(--line); min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.pt-h { display: flex; align-items: baseline; gap: 10px; font-size: 13.5px; font-weight: 700; }
.pt-h span { font-weight: 500; color: var(--muted); }
.pt-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.pt-lab { width: 76px; flex: none; font-size: var(--t-sm); color: var(--muted); }
.pt-cap { font-size: 11.5px; color: var(--muted); }
.pt-tabs { padding: 0; }
.pt-sec > .seg { align-self: flex-start; }
.pt-static { position: static !important; translate: none !important; animation: none !important; }
.pt-hover { background: var(--sunken); }
.pt-pair { display: flex; align-items: flex-start; gap: 24px; }
.pt-tipdemo { display: inline-flex; align-items: center; gap: 10px; }
.pt-tipdemo .tip { position: static !important; translate: none; }
.pt-toasts { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.pt-av { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 8px; font-size: 11.5px; color: var(--muted); }
.pt-status { display: grid; grid-template-columns: 96px auto auto 1fr; align-items: center; justify-items: start; gap: 12px 24px; font-size: 13px; }
.pt-amount { font-weight: 650; }
.side-badge-demo { min-width: 26px; height: 18px; padding: 0 6px; border-radius: 9px; background: var(--err-fill); color: #fff; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.pt-list { display: flex; flex-direction: column; border-top: 1px solid var(--line); }
.pt-li { display: flex; align-items: center; gap: 10px; height: 36px; border-bottom: 1px solid var(--line); font-weight: 600; background: var(--canvas); }
.pt-frame { position: relative; height: 380px; border-radius: var(--r-card); box-shadow: inset 0 0 0 1px var(--line-strong); overflow: hidden; background: var(--canvas); }
.pt-under { position: absolute; inset: 0; padding: 22px 24px; display: flex; flex-direction: column; gap: 12px; }
.pt-abs { position: absolute !important; }
.pt-sheet { position: absolute !important; width: 380px; }
.pt-palframe { display: grid; place-items: start center; padding-top: 28px; background: var(--raised); }
.pt-palframe .palette { width: calc(100% - 56px); }
.pt-box { border: 1px solid var(--line); border-radius: var(--r-card); padding: 32px 24px; }
.pt-skel { display: flex; flex-direction: column; }
.pt-skrow { display: flex; align-items: center; gap: 12px; padding: 12px; border-bottom: 1px solid var(--line); }
`;
