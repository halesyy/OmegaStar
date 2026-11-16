// The notes file open beside a conversation: one at a time, in one conversation. A click on its path in a reply opens
// it, and so does an employee's `open` (the `reader:open` event), even while that conversation is not on screen.
import { createContext } from "react";
import { subscribe } from "../api/client";
import { createStore, useStore } from "./store";

const reader = createStore<{ rootId: string; path: string } | null>(null);

/** Whether a path is a notes file the reader lays out, and which kind: markdown ("md") or plain text ("txt"). */
export const textFile = (path: string): "md" | "txt" | null => {
  const ext = /\.(md|txt)$/i.exec(path)?.[1].toLowerCase();
  return ext === "md" || ext === "txt" ? ext : null;
};

/** Opens `path` beside the conversation whose first run is `rootId`, in place of any file open anywhere. */
export function openReader(rootId: string, path: string) {
  reader.set({ rootId, path });
}

export function closeReader() {
  reader.set(null);
}

/** The path open beside the conversation whose first run is `rootId`, or null. */
export function useReaderPath(rootId: string): string | null {
  const open = useStore(reader);
  return open?.rootId === rootId ? open.path : null;
}

let wired = false;
/** Listens once for an employee's `open` of a notes file. */
export function wireReader() {
  if (wired) return;
  wired = true;
  subscribe("reader:open", ({ rootId, path }) => openReader(rootId, path));
}

/** A thread's reader, for the replies in it: the path open beside it, and `open`, which opens a path there (or closes
 *  it when it is the one open). `link` is the path clicked, kept where it is on screen as the pane opens. */
export type ReaderOpener = { path: string | null; open: (path: string, link: Element) => void };
export const ReaderContext = createContext<ReaderOpener | null>(null);
