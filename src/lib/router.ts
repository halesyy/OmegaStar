import { useSyncExternalStore } from "react";
import { YOU_ID } from "./org";

/** An employee panel's tabs. People and you have a single page, so no tab. */
export type PanelTab = "chat" | "work" | "skills" | "profile";
export type ActivityView = "runs" | "skills";

export type Route =
  | { page: "org"; memberId: string | null; tab: PanelTab | null; focus: string | null }
  | { page: "inbox" }
  | { page: "activity"; view: ActivityView }
  | { page: "settings" }
  | { page: "run"; runId: string };

const TABS: PanelTab[] = ["chat", "work", "skills", "profile"];

function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case "inbox": return { page: "inbox" };
    case "activity": return { page: "activity", view: parts[1] === "skills" ? "skills" : "runs" };
    case "settings": return { page: "settings" };
    case "run": if (parts[1]) return { page: "run", runId: parts[1] }; break;
  }
  const tab = TABS.find((t) => t === parts[2]) ?? null;
  return { page: "org", memberId: parts[1] ?? null, tab, focus: parts[3] ?? null };
}

function routeHash(r: Route): string {
  switch (r.page) {
    case "org": {
      const segs = ["org"];
      if (r.memberId) {
        segs.push(r.memberId);
        if (r.tab) segs.push(r.tab);
        if (r.tab && r.focus) segs.push(r.focus);
      }
      return "#/" + segs.map(encodeURIComponent).join("/");
    }
    case "run": return `#/run/${encodeURIComponent(r.runId)}`;
    case "activity": return r.view === "skills" ? "#/activity/skills" : "#/activity";
    default: return `#/${r.page}`;
  }
}

export function navigate(r: Route, opts: { replace?: boolean } = {}) {
  const h = routeHash(r);
  if (h === location.hash) return;
  if (opts.replace) {
    history.replaceState(null, "", h);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = h;
  }
}

export const openMember = (memberId: string, tab: PanelTab | null = null, focus: string | null = null, replace = false) =>
  navigate({ page: "org", memberId, tab, focus }, { replace });
export const openRun = (runId: string) => navigate({ page: "run", runId });
/** Your own panel on the org chart: name, title, company and who you report to. */
export const openYou = () => openMember(YOU_ID);

function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

// One Route object per hash, so a re-render without navigation hands back the same route.
let lastHash = "\u0000";
let lastRoute: Route = { page: "org", memberId: null, tab: null, focus: null };
function routeOf(hash: string): Route {
  if (hash !== lastHash) {
    lastHash = hash;
    lastRoute = parseHash(hash);
  }
  return lastRoute;
}

export function useRoute(): Route {
  return routeOf(useSyncExternalStore(subscribe, () => location.hash));
}
