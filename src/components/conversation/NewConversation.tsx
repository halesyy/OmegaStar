import { useRef } from "react";
import { call } from "../../api/client";
import type { EmployeeView, NewAttachment } from "../../api/types";
import { firstName } from "../../lib/format";
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

/** A conversation before its first message: what you send starts it, beside everything else the employee is doing,
 *  and opens it. */
export function NewConversation({ e }: { e: EmployeeView }) {
  const surface = useRef<ChatSurfaceHandle>(null);
  const name = firstName(e.name);
  const start = async (text: string, attachments: NewAttachment[]) => {
    const run = await call("start_task", { employeeId: e.id, text, attachments });
    openChat(e.id, threadFocus(run.id), true);
  };
  const teach = () => surface.current?.prefill(TEACH_PREFIX);
  return (
    <ChatSurface
      ref={surface} e={e} busy={false} draftKey={newConversationDraft(e.id)} scrollKey=""
      placeholder={`Message ${name}. Teach them something, or ask.`} onSend={start}
      actions={<button className="btn btn-ghost btn-sm" onClick={teach}><Icon name="teach" size={13} /> Teach a new task</button>}
    >
      <div className="chat-empty">
        <Avatar name={e.name} hue={e.hue} size={56} />
        <h3 className="h-md">Start a conversation with {name}</h3>
        <p className="muted">
          Each conversation is its own thread and runs alongside everything else {name} is doing. Everything you explain
          lands in one of {name}'s skills before they reply, so they keep it for every future run.
        </p>
        <button className="btn btn-primary" onClick={teach}><Icon name="teach" size={14} /> Teach a new task</button>
        <div className="chat-suggest">
          {SUGGESTIONS.map((s) => <button key={s} className="chat-suggestion" onClick={() => surface.current?.prefill(s)}>{s}</button>)}
        </div>
      </div>
    </ChatSurface>
  );
}
