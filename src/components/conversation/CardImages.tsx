import { useState } from "react";
import { useQuery } from "../../lib/hooks";
import { Icon } from "../Icon";
import { Lightbox, loadImage } from "../Markdown";

/** Up to three images a card is about, such as a before and an after, as thumbnails: one opens them all full-window.
 *  One that can no longer be read says so. */
export function CardImages({ paths }: { paths: string[] }) {
  // Read as a message's images are, each once; null: it could not be read.
  const srcs = useQuery(() => Promise.all(paths.map((p) => loadImage(p).catch(() => null))), [paths]).data;
  const [at, setAt] = useState<number | null>(null);
  const shown = paths.filter((_, i) => srcs?.[i]);
  return (
    <div className="card-thumbs">
      {paths.map((path, i) => {
        const src = srcs?.[i];
        const name = path.split(/[\\/]/).pop();
        return src === null ? (
          <span key={i} className="card-thumb card-thumb-missing" role="img" aria-label={`Image not found: ${name}`} title={`Not found: ${path}`}>
            <Icon name="image" size={14} />
          </span>
        ) : (
          <button key={i} type="button" className="card-thumb" disabled={!src} aria-label={`Show ${name}`} title={name} onClick={() => setAt(shown.indexOf(path))}>
            {src ? <img src={src} alt="" /> : null}
          </button>
        );
      })}
      {at !== null ? <Lightbox shots={shown.map((path) => ({ path, caption: "" }))} at={at} onClose={() => setAt(null)} /> : null}
    </div>
  );
}
