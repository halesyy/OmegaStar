import { useEffect, useId, useRef, useState } from "react";
import { whenShort } from "../../lib/format";
import { snoozePresets } from "../../lib/status";
import { Icon } from "../Icon";
import { Popover } from "../ui";

/** A day as a date field holds it, "2026-11-03", in this computer's time zone. */
const fieldDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** One of `snoozePresets` as a menu row: its name, and the time it brings things back. */
export function LaterPreset({ preset, onPick }: { preset: { label: string; until: Date }; onPick: () => void }) {
  return (
    <button type="button" role="menuitem" className="menu-item" onClick={onPick}>
      <span className="grow">{preset.label}</span>
      <span className="faint">{whenShort(preset.until.toISOString()).replace(preset.label === "Tomorrow" ? /^Tomorrow / : /^Today /, "")}</span>
    </button>
  );
}

/** Later, in place of Not now: the card goes away and comes back by itself tomorrow or next week at 9 am, or at 9 am
 *  on a day you pick. Once it has come back (`timesBack`), Later parks it instead, and the menu says so. */
export function LaterMenu({ timesBack, disabled, onLater }: { timesBack: number; disabled: boolean; onLater: (until: Date) => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [day, setDay] = useState("");
  const note = useId();
  useEffect(() => {
    if (open && !picking) requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>("button")?.focus());
  }, [open, picking]);
  const close = () => { setOpen(false); setPicking(false); setDay(""); };
  const choose = (until: Date) => { close(); onLater(until); };
  const parks = timesBack > 0;
  const now = new Date();
  // Days, not hours: a card you put off comes back in the morning.
  const presets = open ? snoozePresets(now).slice(1) : [];
  const pick = () => {
    const [y, m, d] = day.split("-").map(Number);
    const until = new Date(y, m - 1, d, 9);
    if (until.getTime() > Date.now()) choose(until);
  };
  return (
    <>
      <button
        ref={anchor} type="button" className="btn btn-ghost btn-sm" data-card-later aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        title={parks ? "It came back once already, so Later parks it" : "Busy, not a no: pick when it comes back"}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name="clock" size={13} /> Later
      </button>
      <Popover anchor={anchor} open={open} onClose={close} align="end" width={240}>
        <div className="card-later" data-esc-stop>
          {parks ? <p id={note} className="card-later-note">Later parks it: it won't come back by itself.</p> : null}
          {picking ? (
            <form className="card-later-pick" onSubmit={(ev) => { ev.preventDefault(); pick(); }}>
              <input
                className="input" type="date" required autoFocus aria-label="The day it comes back" aria-describedby={parks ? note : undefined}
                min={fieldDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))} value={day} onChange={(ev) => setDay(ev.target.value)}
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={!day}>Later</button>
            </form>
          ) : (
            <div
              ref={list} className="menu" role="menu" aria-label="When it comes back" aria-describedby={parks ? note : undefined}
              onKeyDown={(ev) => {
                if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
                ev.preventDefault();
                const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
                const i = items.indexOf(document.activeElement as HTMLButtonElement);
                items[(i + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
              }}
            >
              {presets.map((p) => <LaterPreset key={p.label} preset={p} onPick={() => choose(p.until)} />)}
              <button type="button" role="menuitem" className="menu-item" onClick={() => setPicking(true)}>Pick a date…</button>
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
