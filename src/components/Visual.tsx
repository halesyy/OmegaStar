import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useResolvedDark } from "../lib/theme";
import { Icon } from "./Icon";
import { Overlay } from "./ui";
import "./Visual.css";

/** Tallest a page grows in a message. Past it, it scrolls in its frame. */
const MAX_HEIGHT = 2000;

/** Where a page is served: a scheme of its own, so its frame shares nothing with the app (`visual_page` in Rust). */
const pageUrl = (runId: string, id: string, dark: boolean) =>
  `${convertFileSrc(`${runId}/${id}`, "omega-visual")}?theme=${dark ? "dark" : "light"}`;

/**
 * A page an employee showed (`show`), as tall as it is, with Expand for a full-window view. Its frame runs the
 * page's own scripts and nothing else: no network, no access to the app, no origin of its own.
 */
export function Visual({ runId, id, title, from }: { runId: string; id: string; title: string; from?: string }) {
  const src = pageUrl(runId, id, useResolvedDark());
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const h = (e.data as { omegaHeight?: unknown } | null)?.omegaHeight;
      if (e.source === frame.current?.contentWindow && typeof h === "number") setHeight(Math.min(MAX_HEIGHT, Math.max(24, h)));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <figure className="visual">
      <figcaption className="visual-head">
        <span className="visual-title"><span className="trunc">{title}</span>{from ? <span className="visual-from">from {from}</span> : null}</span>
        <button className="btn btn-ghost btn-icon btn-sm" aria-label={`Expand ${title}`} data-tip="Expand" onClick={() => setOpen(true)}><Icon name="expand" size={14} /></button>
      </figcaption>
      <div className="visual-body">
        <iframe ref={frame} className={`visual-frame ${height === null ? "visual-wait" : ""}`} src={src} sandbox="allow-scripts" title={title} style={{ height: height ?? 160 }} />
      </div>
      {open ? (
        <Overlay label={title} onClose={() => setOpen(false)}>
          <div className="visual-sheet">
            <div className="visual-head"><span className="visual-title"><span className="trunc">{title}</span>{from ? <span className="visual-from">from {from}</span> : null}</span></div>
            <div className="visual-body"><iframe className="visual-frame" src={src} sandbox="allow-scripts" title={title} /></div>
          </div>
        </Overlay>
      ) : null}
    </figure>
  );
}
