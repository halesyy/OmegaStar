import { errorMessage } from "../../api/client";
import { toast } from "../../lib/toasts";
import { Icon } from "../Icon";

/** A web address a card carries, or null when it is none: only http and https pages open in your browser. */
export function webUrl(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Opens a page in your browser. */
export function openWeb(url: URL) {
  import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url.href)).catch((err) => toast(errorMessage(err), "err"));
}

/** A link in a few words: its host and the end of its path, "github.com/…/pull/12". */
function shortUrl(url: URL): string {
  const host = url.host.replace(/^www\./, "");
  const path = url.pathname.split("/").filter(Boolean);
  return path.length > 2 ? `${host}/…/${path.slice(-2).join("/")}` : [host, ...path].join("/");
}

/** The page a card is about, such as a pull request, by its host and short path. It opens in your browser. */
export function CardLink({ url }: { url: URL }) {
  const short = shortUrl(url);
  return (
    <button type="button" className="btn btn-sm card-link" title={url.href} aria-label={`Open link ${short}`} onClick={() => openWeb(url)}>
      <Icon name="external" size={12} /><span>{short}</span>
    </button>
  );
}
