// localStorage, for per-device conveniences only. It can be unavailable, so reads fall back to null.

export function storageGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
export function storageSet(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
