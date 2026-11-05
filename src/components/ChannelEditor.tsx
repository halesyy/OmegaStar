import { useEffect, useRef, useState } from "react";
import type { Channel, ChannelKind } from "../api/types";
import { CHANNEL_KINDS } from "../lib/channels";
import { CHANNEL_ICON, Icon } from "./Icon";
import "./ChannelEditor.css";

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `ch-${Date.now().toString(36)}`);

export function ChannelEditor({ value, onChange }: { value: Channel[]; onChange: (v: Channel[]) => void }) {
  const [picking, setPicking] = useState(value.length === 0);
  const [focusId, setFocusId] = useState<string | null>(null);
  // The row you just added drops in; the rest hold still.
  const [added, setAdded] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusId) return;
    root.current?.querySelector<HTMLInputElement>(`[data-address="${focusId}"]`)?.focus();
    setFocusId(null);
  }, [focusId]);

  const update = (id: string, patch: Partial<Channel>) => onChange(value.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const move = (i: number, d: -1 | 1) => {
    const next = value.slice();
    const [c] = next.splice(i, 1);
    next.splice(i + d, 0, c);
    onChange(next);
  };
  const add = (kind: ChannelKind) => {
    const c: Channel = { id: newId(), kind, address: "", whenToUse: "" };
    onChange([...value, c]);
    setPicking(false);
    setFocusId(c.id);
    setAdded(c.id);
  };

  return (
    <div className="channels" ref={root}>
      {value.map((c, i) => {
        const meta = CHANNEL_KINDS.find((k) => k.kind === c.kind) ?? CHANNEL_KINDS[CHANNEL_KINDS.length - 1];
        return (
          <div key={c.id} className={`channel ${c.id === added ? "enter-drop" : ""}`}>
            <div className="channel-grip">
              <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="chevronDown" size={12} className="flip" /></button>
              <button type="button" aria-label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}><Icon name="chevronDown" size={12} /></button>
            </div>
            <div className="channel-fields">
              <div className="channel-top">
                <span className="channel-kind">
                  <Icon name={CHANNEL_ICON[c.kind]} size={14} />
                  <select className="select" value={c.kind} aria-label="Channel" onChange={(e) => update(c.id, { kind: e.target.value as ChannelKind })}>
                    {CHANNEL_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                  </select>
                </span>
                <input data-address={c.id} className="input grow" value={c.address} placeholder={meta.placeholder} aria-label={`${meta.label} address`} onChange={(e) => update(c.id, { address: e.target.value })} />
              </div>
              <input className="input channel-when" value={c.whenToUse} placeholder={`When to use: ${meta.whenPlaceholder.toLowerCase()}`} aria-label="When to use" onChange={(e) => update(c.id, { whenToUse: e.target.value })} />
            </div>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Remove ${meta.label}`} onClick={() => onChange(value.filter((x) => x.id !== c.id))}>
              <Icon name="close" size={13} />
            </button>
          </div>
        );
      })}
      {picking ? (
        <div className="channel-kinds" role="group" aria-label="Add a channel">
          {CHANNEL_KINDS.map((k) => (
            <button key={k.kind} type="button" className="chip" onClick={() => add(k.kind)}>
              <Icon name={CHANNEL_ICON[k.kind]} size={13} /> {k.label}
            </button>
          ))}
          {value.length > 0 ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicking(false)}>Cancel</button> : null}
        </div>
      ) : (
        <button type="button" className="btn btn-sm channel-add" onClick={() => setPicking(true)}>
          <Icon name="plus" size={12} /> Add channel
        </button>
      )}
    </div>
  );
}
