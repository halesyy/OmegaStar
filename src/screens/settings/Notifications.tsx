import { useState } from "react";
import type { BusinessHours, CheckFrequency, IsoWeekday, NotificationSettings, NotifyMode, QuietHours, WatchSettings } from "../../api/types";
import { clockHM, plural } from "../../lib/format";
import { usePresence } from "../../lib/motion";
import { Switch } from "../../components/ui";
import { Row, Swap, type Change } from "./rows";
import { Group } from "./frame";

const CHECK_FREQUENCIES: { value: CheckFrequency; label: string }[] = [
  { value: "eager", label: "Often" },
  { value: "normal", label: "Normal" },
  { value: "relaxed", label: "Less often" },
];

const WEEKDAYS: { day: IsoWeekday; label: string; name: string }[] = [
  { day: 1, label: "Mon", name: "Monday" },
  { day: 2, label: "Tue", name: "Tuesday" },
  { day: 3, label: "Wed", name: "Wednesday" },
  { day: 4, label: "Thu", name: "Thursday" },
  { day: 5, label: "Fri", name: "Friday" },
  { day: 6, label: "Sat", name: "Saturday" },
  { day: 7, label: "Sun", name: "Sunday" },
];

const HALF_HOURS = Array.from({ length: 49 }, (_, i) => i * 30);
const NUDGE_DAYS = [0, 1, 2, 3, 4, 5];
const GIVE_UP_DAYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const minuteLabel = (minute: number) => clockHM(Math.floor(minute / 60) % 24, minute % 60);
const businessDays = (n: number) => plural(n, "business day");
const withCurrent = (options: number[], current: number) => (options.includes(current) ? options : [...options, current].sort((a, b) => a - b));

const NOTIFY_MODES: { value: NotifyMode; label: string; desc: string }[] = [
  { value: "all", label: "All", desc: "Each one as it comes." },
  { value: "batched", label: "Batched", desc: "Decisions an employee sends within 90 seconds of the first arrive as one notification." },
  { value: "off", label: "Off", desc: "None. The Inbox and the dock badge still show what waits on you." },
];

/** Quiet hours when you first turn them on: overnight, 10 pm to 8 am. */
const QUIET_HOURS: QuietHours = { startMinute: 22 * 60, endMinute: 8 * 60 };

export function NotificationsGroup({ n, change }: { n: NotificationSettings; change: Change }) {
  const q = n.quiet;
  const setN = (row: string, next: Partial<NotificationSettings>) => change(row, (x) => ({ ...x, notifications: { ...x.notifications, ...next } }));
  const mode = NOTIFY_MODES.find((m) => m.value === n.mode);
  const times = (current: number) => withCurrent(HALF_HOURS.slice(0, -1), current);
  // The times stay on screen while they fade out after quiet hours are turned off.
  const shown = usePresence(!!q, 140);
  const [kept, setKept] = useState<QuietHours>(q ?? QUIET_HOURS);
  if (q && (q.startMinute !== kept.startMinute || q.endMinute !== kept.endMinute)) setKept(q);
  const t = q ?? kept;
  return (
    <Group title="Notifications" sub="Desktop notifications when an employee needs you.">
      <Row title="Desktop notifications" desc={<Swap on={n.mode}>{mode?.desc}</Swap>}>
        <div className="seg" role="group" aria-label="Desktop notifications">
          {NOTIFY_MODES.map((m) => (
            <button key={m.value} aria-pressed={n.mode === m.value} onClick={() => setN("Desktop notifications", { mode: m.value })}>{m.label}</button>
          ))}
        </div>
      </Row>
      <Row title="Quiet hours" desc={<Swap on={q ? "on" : "off"}>{q ? `No notifications from ${minuteLabel(q.startMinute)} to ${minuteLabel(q.endMinute)}. When they end, one notification says what came in.` : "Notifications can come at any hour."}</Swap>}>
        {shown ? (
          <span className={`set-times ${q ? "enter-fade" : "leave-fade"}`}>
            <select className="select set-select" aria-label="Start of quiet hours" value={t.startMinute} disabled={!q} onChange={(e) => setN("Quiet hours", { quiet: { ...t, startMinute: Number(e.target.value) } })}>
              {times(t.startMinute).map((m) => <option key={m} value={m} disabled={m === t.endMinute}>{minuteLabel(m)}</option>)}
            </select>
            <span className="muted">to</span>
            <select className="select set-select" aria-label="End of quiet hours" value={t.endMinute} disabled={!q} onChange={(e) => setN("Quiet hours", { quiet: { ...t, endMinute: Number(e.target.value) } })}>
              {times(t.endMinute).map((m) => <option key={m} value={m} disabled={m === t.startMinute}>{minuteLabel(m)}</option>)}
            </select>
          </span>
        ) : null}
        <Switch checked={!!q} onChange={(v) => setN("Quiet hours", { quiet: v ? kept : null })} label="Quiet hours" />
      </Row>
    </Group>
  );
}

export function RepliesGroup({ w, change }: { w: WatchSettings; change: Change }) {
  const h = w.hours;
  const nudging = w.nudgeAfterDays > 0;
  const setWatch = (row: string, next: Partial<WatchSettings>) => change(row, (x) => ({ ...x, watch: { ...x.watch, ...next } }));
  const setHours = (next: Partial<BusinessHours>) => change("Business hours", (x) => ({ ...x, watch: { ...x.watch, hours: { ...x.watch.hours, ...next } } }));
  const toggleDay = (day: IsoWeekday) =>
    setHours({ days: h.days.includes(day) ? h.days.filter((d) => d !== day) : [...h.days, day].sort((a, b) => a - b) });

  return (
    <Group title="Replies from people" sub="When an employee asks someone on your org chart, Omega Star watches for the reply and reminds them once.">
      <Row title="Business hours" desc="Reminders and give-ups count only these hours. Teams chats are still checked outside them, less often.">
        <div className="set-hours">
          <span className="set-times">
            <select className="select set-select" aria-label="Start of the working day" value={h.startMinute} onChange={(e) => setHours({ startMinute: Number(e.target.value) })}>
              {withCurrent(HALF_HOURS.slice(0, -1), h.startMinute).map((m) => <option key={m} value={m} disabled={m >= h.endMinute}>{minuteLabel(m)}</option>)}
            </select>
            <span className="muted">to</span>
            <select className="select set-select" aria-label="End of the working day" value={h.endMinute} onChange={(e) => setHours({ endMinute: Number(e.target.value) })}>
              {withCurrent(HALF_HOURS.slice(1), h.endMinute).map((m) => <option key={m} value={m} disabled={m <= h.startMinute}>{minuteLabel(m)}</option>)}
            </select>
          </span>
          <div className="set-days" role="group" aria-label="Working days">
            {WEEKDAYS.map((d) => {
              const on = h.days.includes(d.day);
              const last = on && h.days.length === 1;
              return (
                <button key={d.day} type="button" aria-pressed={on} aria-label={d.name} aria-disabled={last || undefined} onClick={() => { if (!last) toggleDay(d.day); }}>
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
      </Row>
      <Row title="Check for replies" desc="How often Omega Star looks. Checks start often and slow down as an ask gets older.">
        <div className="seg" role="group" aria-label="Check frequency">
          {CHECK_FREQUENCIES.map((f) => (
            <button key={f.value} aria-pressed={w.frequency === f.value} onClick={() => setWatch("Check for replies", { frequency: f.value })}>{f.label}</button>
          ))}
        </div>
      </Row>
      <Row title="Nudge after" desc={<Swap on={String(nudging)}>{nudging ? "With no reply, the employee sends one short reminder: at the due date, or after this long if there isn't one." : "Nobody gets a reminder."}</Swap>}>
        <select className="select set-select" aria-label="Nudge after" value={w.nudgeAfterDays} onChange={(e) => setWatch("Nudge after", { nudgeAfterDays: Number(e.target.value) })}>
          {withCurrent(NUDGE_DAYS, w.nudgeAfterDays).map((d) => <option key={d} value={d} disabled={d > 0 && d >= w.giveUpAfterDays}>{d === 0 ? "Never" : businessDays(d)}</option>)}
        </select>
      </Row>
      <Row title="Give up after" desc="Then the employee goes on without the answer, or asks someone else. Counted from the due date if that's later.">
        <select className="select set-select" aria-label="Give up after" value={w.giveUpAfterDays} onChange={(e) => setWatch("Give up after", { giveUpAfterDays: Number(e.target.value) })}>
          {withCurrent(GIVE_UP_DAYS, w.giveUpAfterDays).map((d) => <option key={d} value={d} disabled={nudging && d <= w.nudgeAfterDays}>{businessDays(d)}</option>)}
        </select>
      </Row>
    </Group>
  );
}
