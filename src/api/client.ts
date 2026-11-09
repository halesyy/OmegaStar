import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ApiError, CommandName, Commands, EventName, Events } from "./types";

/** A transport: the Office over Tauri IPC, or the browser preview's invented office. */
export type Transport = {
  invoke<K extends CommandName>(name: K, args: Commands[K]["args"]): Promise<Commands[K]["ret"]>;
  listen<E extends EventName>(name: E, handler: (payload: Events[E]) => void): Promise<() => void>;
};

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const tauriTransport: Transport = {
  invoke,
  listen: (name, handler) => listen(name, (e) => handler(e.payload as Events[typeof name])),
};

let transport: Promise<Transport> | null = null;
function getTransport(): Promise<Transport> {
  if (!transport) {
    transport = inTauri ? Promise.resolve(tauriTransport)
      // `npm run dev` in a plain browser: the invented office in src/preview. Vite drops this from builds.
      : import.meta.env.DEV ? import("../preview/transport").then((m) => m.previewTransport())
      : Promise.reject(new OfficeError({ code: "unavailable", message: "Omega Star runs in its desktop app." }));
  }
  return transport;
}

class OfficeError extends Error {
  readonly code: string;
  constructor(e: ApiError) {
    super(e.message);
    this.code = e.code;
  }
}

function toOfficeError(e: unknown): OfficeError {
  if (e instanceof OfficeError) return e;
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") {
    const code = "code" in e && typeof e.code === "string" ? e.code : "unknown";
    return new OfficeError({ code, message: e.message });
  }
  return new OfficeError({ code: "unknown", message: typeof e === "string" ? e : "Something went wrong." });
}

export async function call<K extends CommandName>(
  name: K,
  ...rest: Commands[K]["args"] extends Record<string, never> ? [] : [Commands[K]["args"]]
): Promise<Commands[K]["ret"]> {
  const t = await getTransport();
  const args = (rest[0] ?? {}) as Commands[K]["args"];
  try {
    return await t.invoke(name, args);
  } catch (e) {
    throw toOfficeError(e);
  }
}

type Handler<E extends EventName> = (payload: Events[E]) => void;
const subscribers: { [E in EventName]?: Set<Handler<E>> } = {};
const attached = new Set<EventName>();

/** Subscribe to an Office event. Returns a synchronous unsubscribe. One IPC listener per event name. */
export function subscribe<E extends EventName>(name: E, handler: Handler<E>): () => void {
  let set = subscribers[name] as Set<Handler<E>> | undefined;
  if (!set) {
    set = new Set();
    (subscribers as Record<EventName, Set<Handler<E>>>)[name] = set;
  }
  set.add(handler);
  if (!attached.has(name)) {
    attached.add(name);
    void getTransport().then((t) =>
      t.listen(name, (payload) => {
        const current = subscribers[name] as Set<Handler<E>> | undefined;
        current?.forEach((h) => h(payload));
      }),
    );
  }
  return () => {
    set.delete(handler);
  };
}

export function errorMessage(e: unknown): string {
  return toOfficeError(e).message;
}
