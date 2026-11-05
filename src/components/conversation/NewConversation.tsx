import { useRef } from "react";
import { call } from "../../api/client";
import type { EmployeeView, NewAttachment } from "../../api/types";
import { firstName, relTime, whenInline } from "../../lib/format";
import { openChat } from "../../lib/router";
import { threadFocus } from "../../lib/threads";
import { Icon } from "../Icon";
import { Avatar } from "../ui";
import { ChatSurface, type ChatSurfaceHandle } from "../panel/ChatSurface";
import "../panel/ChatTab.css";

const TEACH_PREFIX = "I want to teach you a new task: ";
const SUGGESTIONS = [
  "What's your objective, in your own words?",
  "When you're unsure, ask me before acting.",
  "Here's how I like reports written: status line first, then evidence.",
];

/** The draft key of an employee's new-conversation composer, so a message can wait in it, such as a hire's first lesson. */
export const newConversationDraft = (employeeId: string): string => `new-conversation:${employeeId}`;

/** Where they are now, in a word: working, up next, their next run, or when they last worked. */
function Now({ e }: { e: EmployeeView }) {
  if (e.presence === "working") return <span className="status status-live">Working</span>;
  if (e.presence === "queued") return <span className="status status-wait">Up next</span>;
  if (e.presence === "attention") return <span className="status status-attn">Needs you</span>;
  if (e.nextFire) return <span>Next run {whenInline(e.nextFire)}</span>;
  if (e.lastWorkedAt) return <span>Last worked {relTime(e.lastWorkedAt)}</span>;
  return <span>No runs yet</span>;
}

/** A conversation before its first message, as meeting a colleague: who they are and what they are doing now, one
 *  sentence on how conversations work, then three ways to start. What you send starts it and opens it. `compact` leaves
 *  out who they are, for a person's panel, whose head already says it. */
export function NewConversation({ e, compact = false }: { e: EmployeeView; compact?: boolean }) {
  const surface = useRef<ChatSurfaceHandle>(null);
  const name = firstName(e.name);
  const start = async (text: string, attachments: NewAttachment[]) => {
    const run = await call("start_task", { employeeId: e.id, text, attachments });
    openChat(e.id, threadFocus(run.id), true);
  };
  return (
    <ChatSurface
      ref={surface} e={e} busy={false} draftKey={newConversationDraft(e.id)} scrollKey="" pin={false}
      placeholder={`Message ${name}. Teach them something, or ask.`} onSend={start}
      actions={<button className="btn btn-ghost btn-sm" data-tip="Teach a new task" onClick={() => surface.current?.prefill(TEACH_PREFIX)}><Icon name="teach" size={14} /> <span className="btn-label">Teach a new task</span></button>}
    >
      <div className="chat-inner">
        <div className="chat-start">
          {compact ? null : <div className="chat-start-who">
            <Avatar name={e.name} hue={e.hue} size={48} />
            <div>
              <div className="chat-start-name">{e.name}</div>
              <div className="chat-start-role">{e.title} · <Now e={e} /></div>
            </div>
          </div>}
          <p className="chat-start-note">
            Each conversation runs alongside {name}'s other work, and what you explain goes into {name}'s skills, so it holds for every run after.
          </p>
          <div>
            <div className="chat-start-sec">Start with</div>
            <div className="chat-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chat-suggestion" onClick={() => surface.current?.prefill(s)}>
                  <Icon name="chat" size={14} /><span className="grow">{s}</span><Icon name="arrowRight" size={13} />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </ChatSurface>
  );
}
