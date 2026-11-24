import { useCallback, useEffect, useRef, useState } from "react";
import { call, errorMessage, subscribe } from "../api/client";
import type { Conversations, EventName, HireProposal, ModelOption, OrgSnapshot, Run, SkillInfo, SkillSources, UsageLimits } from "../api/types";
import { createStore, useStore } from "./store";
import { applyChild, applyEvents, applyRun, emptyLiveRun, isChildOf, liveRunOf, type LiveRun } from "./runs";
import { toast } from "./toasts";

export type Query<T> = { data: T | undefined; error: string | null; loading: boolean; reload: () => void; set: (v: T) => void };

/** Fetch with `fn` whenever `deps` (plain values) change, refetching (debounced, keeping stale data) when any of `events` fires. */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[], events: EventName[] = []): Query<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const load = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    fnRef.current().then(
      (v) => { if (n === seq.current) { setData(v); setError(null); setLoading(false); } },
      (e) => { if (n === seq.current) { setError(errorMessage(e)); setLoading(false); } },
    );
  }, []);

  const depKey = JSON.stringify(deps);
  useEffect(() => {
    setData(undefined);
    load();
  }, [depKey, load]);

  const evKey = events.join(",");
  useEffect(() => {
    if (!evKey) return;
    let t: number | undefined;
    const kick = () => { window.clearTimeout(t); t = window.setTimeout(load, 120); };
    const offs = evKey.split(",").map((e) => subscribe(e as EventName, kick));
    return () => { window.clearTimeout(t); offs.forEach((o) => o()); };
  }, [evKey, load]);

  return { data, error, loading, reload: load, set: setData };
}

// ---------------------------------------------------------------- models

let lastModels: ModelOption[] | undefined;

/** Claude Code's model list, asked for again each time a picker opens so a newly released model turns up;
 *  the last answer shows meanwhile. `failed`: it gave no list and there is no earlier one. */
export function useModels(): { models: ModelOption[] | undefined; failed: boolean } {
  const q = useQuery(() => call("models").then((m) => (lastModels = m)), []);
  return { models: q.data ?? lastModels, failed: q.error !== null && lastModels === undefined };
}

// ---------------------------------------------------------------- org (shared)

type OrgState = { snap: OrgSnapshot | null; error: string | null };
const org = createStore<OrgState>({ snap: null, error: null });
let orgWired = false;
let orgSeq = 0;

export function refreshOrg() {
  const n = ++orgSeq;
  call("org").then(
    (snap) => { if (n === orgSeq) org.set({ snap, error: null }); },
    (e) => { if (n === orgSeq) org.set({ snap: org.get().snap, error: errorMessage(e) }); },
  );
}
function wireOrg() {
  if (orgWired) return;
  orgWired = true;
  let t: number | undefined;
  const kick = () => { window.clearTimeout(t); t = window.setTimeout(refreshOrg, 80); };
  subscribe("org:changed", kick);
  subscribe("run:updated", kick);
  subscribe("request:updated", kick);
  refreshOrg();
}

export function useOrg(): OrgState {
  useEffect(wireOrg, []);
  return useStore(org);
}

// ---------------------------------------------------------------- conversations (shared)

type ConversationsState = { data: Conversations | null; error: string | null };
const conversations = createStore<ConversationsState>({ data: null, error: null });
let conversationsWired = false;
let conversationsSeq = 0;

/** Takes a thread you just marked done out of every conversation at once, ahead of the reread that confirms it.
 *  A reread already on its way is dropped, so it cannot bring the thread back. */
export function dropConversation(rootId: string) {
  const { data } = conversations.get();
  if (!data) return;
  conversationsSeq++;
  conversations.set({ data: { ...data, threads: data.threads.filter((t) => t.root.id !== rootId), inbox: data.inbox.filter((id) => id !== rootId) }, error: null });
}

/** Rereads every conversation. */
export function refreshConversations() {
  const n = ++conversationsSeq;
  call("conversations").then(
    (data) => { if (n === conversationsSeq) conversations.set({ data, error: null }); },
    (e) => { if (n === conversationsSeq) conversations.set({ data: conversations.get().data, error: errorMessage(e) }); },
  );
}
function wireConversations() {
  if (conversationsWired) return;
  conversationsWired = true;
  let t: number | undefined;
  const kick = () => { window.clearTimeout(t); t = window.setTimeout(refreshConversations, 120); };
  subscribe("run:updated", kick);
  subscribe("org:changed", kick);
  refreshConversations();
}

/** Every conversation across the office, for the Inbox, the sidebar and the conversation screen; one read shared by
 *  every reader. */
export function useConversations(): ConversationsState {
  useEffect(wireConversations, []);
  return useStore(conversations);
}

// ---------------------------------------------------------------- skill catalog + sources (shared)

export type SkillScan = { catalog: SkillInfo[] | null; sources: SkillSources | null; error: string | null; scanning: boolean };
const skillScan = createStore<SkillScan>({ catalog: null, sources: null, error: null, scanning: false });
let skillSeq = 0;

const patchScan = (next: Partial<SkillScan>) => skillScan.set({ ...skillScan.get(), ...next });

/** Rescans the user's Claude Code skills. Every picker and the Settings row update together. */
export function rescanSkills() {
  const n = ++skillSeq;
  patchScan({ scanning: true });
  Promise.all([call("skill_catalog"), call("skill_sources")]).then(
    ([catalog, sources]) => { if (n === skillSeq) patchScan({ catalog, sources, error: null, scanning: false }); },
    (e) => { if (n === skillSeq) patchScan({ error: errorMessage(e), scanning: false }); },
  );
}
/** The last scan, without starting one. */
export const useSkillScan = () => useStore(skillScan);

/** The catalog, rescanned on mount (you may have added skills since), showing the last scan meanwhile. */
export function useCatalog(): Query<SkillInfo[]> {
  useEffect(rescanSkills, []);
  const s = useSkillScan();
  return { data: s.catalog ?? undefined, error: s.error, loading: s.scanning, reload: rescanSkills, set: (catalog) => patchScan({ catalog }) };
}

// ---------------------------------------------------------------- hire proposals (shared)

const proposals = createStore<HireProposal[] | null>(null);
let proposalsWired = false;

function wireProposals() {
  if (proposalsWired) return;
  proposalsWired = true;
  call("proposals").then(proposals.set, () => {});
  subscribe("proposal:updated", (p) => {
    const cur = proposals.get() ?? [];
    proposals.set(cur.some((x) => x.id === p.id) ? cur.map((x) => (x.id === p.id ? p : x)) : [p, ...cur]);
  });
}
/** Every hire proposal, newest first, kept current by `proposal:updated`. `null` until loaded. */
export function useProposals(): HireProposal[] | null {
  useEffect(wireProposals, []);
  return useStore(proposals);
}

// ---------------------------------------------------------------- usage limits

/** Claude subscription usage, kept current by `usage:updated`. `refresh` probes now. */
export function useUsage(): { usage: UsageLimits | null; refreshing: boolean; refresh: () => void } {
  const [usage, setUsage] = useState<UsageLimits | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let alive = true;
    call("usage_limits").then((u) => { if (alive) setUsage((cur) => cur ?? u); }, () => {});
    const off = subscribe("usage:updated", (u) => setUsage(u));
    return () => { alive = false; off(); };
  }, []);
  const refresh = useCallback(() => {
    setRefreshing(true);
    call("refresh_usage").then(setUsage, (e) => toast(errorMessage(e), "err")).finally(() => setRefreshing(false));
  }, []);
  return { usage, refreshing, refresh };
}

// ---------------------------------------------------------------- live runs

type LiveRuns = { runs: LiveRun[] | null; error: string | null; reload: () => void; appendRun: (r: Run) => void };

/**
 * Runs with their transcripts, kept current by `run:updated` and `run:event`. `load` lists them; `belongs`
 * admits runs that arrive later, so a new turn of a conversation joins as soon as it is created.
 */
function useLiveRuns(load: () => Promise<LiveRun[]>, belongs: (r: Run) => boolean, deps: unknown[], seed?: () => LiveRun[] | null): LiveRuns {
  // What was last seen shows at once while the fresh copy loads.
  const [runs, setRuns] = useState<LiveRun[] | null>(() => seed?.() ?? null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const belongsRef = useRef(belongs);
  belongsRef.current = belongs;

  const reload = useCallback(() => {
    const n = ++seq.current;
    loadRef.current().then(
      (rs) => { if (n === seq.current) { setRuns(rs); setError(null); } },
      (e) => { if (n === seq.current) setError(errorMessage(e)); },
    );
  }, []);

  const depKey = JSON.stringify(deps);
  const shownKey = useRef(depKey);
  const seedRef = useRef(seed);
  seedRef.current = seed;
  useEffect(() => {
    if (shownKey.current !== depKey) {
      shownKey.current = depKey;
      setRuns(seedRef.current?.() ?? null);
      setError(null);
    }
    reload();
  }, [depKey, reload]);

  const appendRun = useCallback((r: Run) => {
    setRuns((rs) => (rs && !rs.some((x) => x.run.id === r.id) ? [...rs, emptyLiveRun(r)] : rs));
  }, []);

  useEffect(() => {
    const offRun = subscribe("run:updated", (r) => {
      setRuns((rs) => {
        if (!rs) return rs;
        const i = rs.findIndex((x) => x.run.id === r.id);
        if (i >= 0) return rs.map((x, j) => (j === i ? applyRun(x, r) : x));
        if (belongsRef.current(r)) return [...rs, emptyLiveRun(r)];
        return rs.some((x) => isChildOf(r, x.run.id)) ? rs.map((x) => (isChildOf(r, x.run.id) ? applyChild(x, r) : x)) : rs;
      });
    });
    const offEv = subscribe("run:event", (p) => {
      setRuns((rs) => (rs && rs.some((x) => x.run.id === p.runId) ? rs.map((x) => (x.run.id === p.runId ? applyEvents(x, p.events) : x)) : rs));
    });
    return () => { offRun(); offEv(); };
  }, []);

  return { runs, error, reload, appendRun };
}

const details = (ids: string[]) => Promise.all(ids.map((runId) => call("run_detail", { runId }).then(liveRunOf)));

/** One run with its live transcript, sub-agents and the runs it handed work to. */
export function useRunDetail(runId: string): LiveRun | null {
  const { runs } = useLiveRuns(() => details([runId]), () => false, [runId]);
  return runs?.[0] ?? null;
}

export type Conversation = { turns: LiveRun[] | null; error: string | null; reload: () => void; appendRun: (r: Run) => void };

/** A thread as a conversation: the report (or your first message) first, then every reply, and every answer a
 *  colleague brought back into it. A turn that comes later joins as it is created. */
export function useThread(rootId: string): Conversation {
  const { runs, ...rest } = useLiveRuns(
    () => loadThread(rootId),
    (r) => r.id === rootId || (r.kind.type === "reply" && r.kind.toRunId === rootId) || (r.kind.type === "answered" && r.kind.thread === rootId),
    [rootId],
    () => cachedThread(rootId),
  );
  useEffect(() => { if (runs) remember(rootId, runs); }, [rootId, runs]);
  return { turns: runs, ...rest };
}

// The conversations opened lately, as last seen, so switching back to one shows it at once while it refreshes.
const THREADS_KEPT = 12;
const seenThreads = new Map<string, LiveRun[]>();
const threadReads = new Map<string, Promise<LiveRun[]>>();

function remember(rootId: string, runs: LiveRun[]) {
  seenThreads.delete(rootId);
  seenThreads.set(rootId, runs);
  for (const old of seenThreads.keys()) {
    if (seenThreads.size <= THREADS_KEPT) break;
    seenThreads.delete(old);
  }
}

/** A thread's turns read fresh, sharing a read already under way. */
function loadThread(rootId: string): Promise<LiveRun[]> {
  const going = threadReads.get(rootId);
  if (going) return going;
  const p = call("thread", { runId: rootId })
    .then((t) => details([t.root.id, ...t.replies.map((r) => r.id)]))
    .then((rs) => { remember(rootId, rs); return rs; })
    .finally(() => threadReads.delete(rootId));
  threadReads.set(rootId, p);
  return p;
}

/** The thread as last seen, when it was opened lately. */
export function cachedThread(rootId: string): LiveRun[] | null {
  return seenThreads.get(rootId) ?? null;
}

/** Reads a thread ahead of opening it (on hover, or while the one on screen stays up), unless it is at hand. */
export function prefetchThread(rootId: string): Promise<unknown> {
  return seenThreads.has(rootId) ? Promise.resolve() : loadThread(rootId).then(() => {}, () => {});
}

// ---------------------------------------------------------------- forms

/**
 * A form's edits over `base`, the saved value. Outside changes to `base` (say, an "Always allow"
 * elsewhere) flow in while the form is clean; once you have edited it, yours are kept until saved or discarded.
 */
export function useDraft<T extends object>(base: T) {
  const [draft, setDraft] = useState(base);
  const [seen, setSeen] = useState(base);
  const same = (a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
  if (seen !== base) {
    setSeen(base);
    if (same(draft, seen)) setDraft(base);
  }
  const set = useCallback(<K extends keyof T>(k: K, v: T[K]) => setDraft((d) => ({ ...d, [k]: v })), []);
  return { draft, setDraft, set, dirty: !same(draft, base), reset: () => setDraft(base) };
}

// ---------------------------------------------------------------- small utilities

export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const h = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(h);
  }, [intervalMs, enabled]);
  return now;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(h);
  }, [value, ms]);
  return v;
}
