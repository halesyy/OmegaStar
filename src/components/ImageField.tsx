import { useRef } from "react";
import { toast } from "../lib/toasts";
import { Avatar } from "./ui";

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
  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      onChange(await displayImage(file));
    } catch {
      toast("That file is not a picture Omega Star can read.", "err");
    }
  };
  return (
    <div className="field">
      <span className="field-label">Display image</span>
      <div className="row" style={{ gap: 12 }}>
        <Avatar name={name} hue={hue} image={image} size={40} person={person} you={you} />
        <button type="button" className="btn btn-sm" onClick={() => picker.current?.click()}>{image ? "Change image" : "Choose image"}</button>
        {image ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(null)}>Remove</button> : null}
        <input ref={picker} type="file" accept="image/*" hidden onChange={(ev) => { void pick(ev.target.files?.[0]); ev.target.value = ""; }} />
      </div>
      <span className="field-help">Shown in place of {you ? "your" : "their"} initials wherever {you ? "you appear" : "they appear"}.</span>
    </div>
  );
}
