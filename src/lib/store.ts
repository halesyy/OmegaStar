import { useSyncExternalStore } from "react";

/** A value shared by every component that reads it: `set` replaces it and they all re-render. */
type Store<T> = { get: () => T; set: (next: T) => void; subscribe: (cb: () => void) => () => void };

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => { value = next; subs.forEach((s) => s()); },
    subscribe: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}
