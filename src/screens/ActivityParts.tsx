import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import "./ActivityParts.css";

/**
 * Something couldn't load: the parts sheet's error card, at its width, in the same place on every page of the area
 * (the top of the content, on the title's left edge). What happened, what happens next, and one way to act. A missing
 * thing is the same card without the alert, since nothing went wrong.
 */
export function ErrorCard({ title, text, action, onRetry, alert = true }: {
  title: string; text: ReactNode; action?: ReactNode; onRetry?: () => void; alert?: boolean;
}) {
  return (
    <div className="act-error" role={alert ? "alert" : "status"}>
      {alert ? <Icon name="alert" size={15} className="act-error-icon" /> : null}
      <div className="act-error-body">
        <div className="act-error-title">{title}</div>
        <div className="act-error-text">{text}</div>
      </div>
      {action ?? (onRetry ? <button className="btn btn-sm" onClick={onRetry}><Icon name="refresh" size={12} /> Try again</button> : null)}
    </div>
  );
}

/** Nothing here yet: the parts sheet's empty pattern without a box. The message set as page type in the upper third of
 *  the page, on the title's left edge, with at most one action. */
export function EmptyPage({ title, text, action }: { title: string; text: ReactNode; action?: ReactNode }) {
  return (
    <div className="act-blank">
      <p className="act-blank-title">{title}</p>
      <p className="act-blank-text">{text}</p>
      {action ? <div className="act-blank-action">{action}</div> : null}
    </div>
  );
}
