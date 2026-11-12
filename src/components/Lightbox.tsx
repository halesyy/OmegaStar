import { useCallback, useEffect, useReducer, useState } from "react";
import { call, errorMessage } from "../api/client";
import { toast } from "../lib/toasts";
import { Icon } from "./Icon";
import { Overlay } from "./ui";

const images = new Map<string, Promise<string>>();
/** The images that have loaded, so a lightbox shows one at once. */
const loaded = new Map<string, string>();

/** Reads a local image once, as a URL an <img> can show; recent ones are kept. */
export function loadImage(path: string): Promise<string> {
  let p = images.get(path);
  if (!p) {
    p = call("read_image", { path });
    p.then((src) => loaded.set(path, src), () => images.delete(path));
    images.set(path, p);
    if (images.size > 20) {
      const oldest = images.keys().next().value!;
      images.delete(oldest);
      loaded.delete(oldest);
    }
  }
  return p;
}

export type Shot = { path: string; caption: string };

/** The images of one message, full-window. The arrow keys move between them. */
export function Lightbox({ shots, at, onClose }: { shots: Shot[]; at: number; onClose: () => void }) {
  const [i, setI] = useState(at);
  const shot = shots[i];
  const [, loadedOne] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    loadImage(shot.path).then(loadedOne, () => {});
  }, [shot.path]);
  const src = loaded.get(shot.path);
  const move = useCallback((by: number) => setI((n) => Math.min(shots.length - 1, Math.max(0, n + by))), [shots.length]);
  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    move(e.key === "ArrowLeft" ? -1 : 1);
  }, [move]);
  const name = shot.caption || shot.path.split(/[\\/]/).pop()!;
  return (
    <Overlay label={name} onClose={onClose} onKey={onKey}>
      <div className="lightbox">
        {src ? <img className="lightbox-img" src={src} alt={name} /> : <div className="lightbox-img lightbox-wait" />}
        <div className="lightbox-bar">
          <span className="lightbox-caption" title={shot.path}>{name}</span>
          {shots.length > 1 ? <span className="lightbox-count num">{i + 1} of {shots.length}</span> : null}
          <button className="btn btn-sm" onClick={() => call("open_image", { path: shot.path }).catch((err) => toast(errorMessage(err), "err"))}>
            <Icon name="external" size={13} /> Open
          </button>
        </div>
      </div>
      {shots.length > 1 ? (
        <>
          <button className="overlay-nav overlay-prev" disabled={i === 0} onClick={() => move(-1)} aria-label="Previous image"><Icon name="arrowLeft" size={16} /></button>
          <button className="overlay-nav overlay-next" disabled={i === shots.length - 1} onClick={() => move(1)} aria-label="Next image"><Icon name="arrowRight" size={16} /></button>
        </>
      ) : null}
    </Overlay>
  );
}
