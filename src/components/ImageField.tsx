import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_AVATARS } from "../lib/defaultAvatars";
import { toast } from "../lib/toasts";
import { Avatar } from "./ui";
import "./ImageField.css";

/** Side of a display image, in pixels: sharp at the largest avatar (56px) on a 2x screen. */
const IMAGE_SIDE = 128;

/** A picture as a display image: its middle square, scaled down, as a data URL (WebP, or PNG where the webview cannot
 *  write WebP). Rejects a file that is not a picture. */
async function displayImage(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = IMAGE_SIDE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No canvas");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, IMAGE_SIDE, IMAGE_SIDE);
  bmp.close();
  return canvas.toDataURL("image/webp", 0.9);
}

/** A display image for anyone on the chart, shown in place of their initials: their avatar as it will look, and a way
 *  to choose, change or remove it. The change is part of the form it sits in, saved with the rest. */
export function ImageField({ name, hue, image, person = false, you = false, onChange }: {
  name: string; hue: number; image: string | null | undefined; person?: boolean; you?: boolean; onChange: (image: string | null) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const disclosure = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const choicesId = useId();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => () => { request.current++; }, [image]);

  const change = (value: string | null) => {
    request.current++;
    onChange(value);
  };
  const close = () => {
    setExpanded(false);
    disclosure.current?.focus();
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    const current = ++request.current;
    try {
      const value = await displayImage(file);
      if (current === request.current) onChange(value);
    } catch {
      if (current === request.current) toast("That file is not a picture Omega Star can read.", "err");
    }
  };
  return (
    <div className="field" onKeyDown={(event) => {
      if (expanded && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }}>
      <span className="field-label">Display image</span>
      <div className="row image-field-controls">
        <Avatar name={name} hue={hue} image={image} size={40} person={person} you={you} />
        <button ref={disclosure} type="button" className="btn btn-sm" aria-expanded={expanded} aria-controls={choicesId} onClick={() => setExpanded(!expanded)}>Choose avatar</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => picker.current?.click()}>Upload image</button>
        {image ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => change(null)}>Remove</button> : null}
        <input ref={picker} type="file" accept="image/*" hidden onChange={(ev) => { void pick(ev.target.files?.[0]); ev.target.value = ""; }} />
      </div>
      {expanded ? (
        <div id={choicesId} className="image-field-choices" role="group" aria-label="Default avatars">
          {DEFAULT_AVATARS.map((avatar) => (
            <button key={avatar.id} type="button" className="image-field-choice" aria-label={`Use ${avatar.name} avatar`} aria-pressed={image === avatar.image} title={avatar.name}
              onClick={() => { change(avatar.image); close(); }}>
              <img src={avatar.image} alt="" width={48} height={48} draggable={false} />
            </button>
          ))}
        </div>
      ) : null}
      <span className="field-help">Shown in place of {you ? "your" : "their"} initials wherever {you ? "you appear" : "they appear"}.</span>
    </div>
  );
}
