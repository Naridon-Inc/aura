// AURA-19 — shared radar-presence store for the editor surface.
//
// The Team Radar rail panel already polls `aura_radar`, but only while that
// panel is mounted. Presence pips on file tabs and gutter markers need the
// same feed *whenever the editor is visible*, without every FileTab spinning
// up its own poll. This module owns ONE refcounted poll per repo root:
// components subscribe via `useRadarPresence`, the first subscriber starts
// the interval, the last one stops it. Polling pauses while the document is
// hidden (same cadence discipline as useTeamRadar / usePresence).
//
// Derivation, not raw feed: events are reduced to "who is on which file
// right now" — latest live event per (actor, file), self excluded via the
// `me` field the Tauri command stamps into the view, stale entries dropped
// after PRESENCE_TTL_MS. Committed/paused/abandoned events *clear* an
// actor's claim on the file instead of contributing presence.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, type RadarEvent } from "./api";

/** One live "peer is on this file" fact, ready for pips and tooltips. */
export type FilePresence = {
  /** Full actor handle, e.g. "ashiq" or "claude@cli". */
  actor: string;
  isAgent: boolean;
  /** The awareness kind that produced this entry (editing | intent | started). */
  kind: string;
  /** Event file path as emitted — usually repo-relative. */
  file: string;
  symbol: string | null;
  /** Unix-ms timestamp of the underlying event. */
  ts: number;
  /** Stable per-actor accent color (same palette as gutter presence). */
  color: string;
};

const POLL_MS = 7000;
/** An actor's presence on a file evaporates after this without a fresh event. */
const PRESENCE_TTL_MS = 10 * 60 * 1000;
/** Kinds that assert presence on a file. */
const LIVE_KINDS = new Set(["editing", "intent", "started"]);
/** Kinds that retract an actor's presence on a file. */
const CLEAR_KINDS = new Set(["committed", "paused", "abandoned"]);

// Same palette as usePresence's gutter pips so an actor reads as one color
// across tab pip, gutter marker, and (eventually) chat.
const PRESENCE_PALETTE = [
  "#7dd3fc", // sky-300
  "#fcd34d", // amber-300
  "#86efac", // emerald-300
  "#f9a8d4", // pink-300
  "#c4b5fd", // violet-300
  "#fdba74", // orange-300
];

export function presenceColorFor(actor: string): string {
  let h = 0;
  for (let i = 0; i < actor.length; i++) {
    h = (h * 31 + actor.charCodeAt(i)) | 0;
  }
  return PRESENCE_PALETTE[Math.abs(h) % PRESENCE_PALETTE.length];
}

type RepoState = {
  entries: FilePresence[];
  subscribers: Set<() => void>;
  timer: number | null;
  inFlight: boolean;
};

const repos = new Map<string, RepoState>();

function stateFor(repoRoot: string): RepoState {
  let s = repos.get(repoRoot);
  if (!s) {
    s = { entries: [], subscribers: new Set(), timer: null, inFlight: false };
    repos.set(repoRoot, s);
  }
  return s;
}

/** Reduce the raw feed to live per-(actor,file) presence. Exported for tests
 *  and pure enough to call anywhere. `me` (git user.name) is excluded; agent
 *  actors are kept even on my machine — "claude editing this file" is signal,
 *  not noise, when the user has fleets running. */
export function derivePresence(
  events: RadarEvent[],
  me: string | null | undefined,
  nowMs: number,
): FilePresence[] {
  const meLower = me?.trim().toLowerCase() ?? "";
  // newest event per (actor, file) decides that pair's fate.
  const latest = new Map<string, RadarEvent>();
  for (const ev of events) {
    if (!ev.file) continue;
    if (!LIVE_KINDS.has(ev.kind) && !CLEAR_KINDS.has(ev.kind)) continue;
    if (meLower && ev.actor.trim().toLowerCase() === meLower) continue;
    const key = `${ev.actor.toLowerCase()}\u0000${ev.file.toLowerCase()}`;
    const prev = latest.get(key);
    if (!prev || ev.ts > prev.ts) latest.set(key, ev);
  }
  const out: FilePresence[] = [];
  for (const ev of latest.values()) {
    if (!LIVE_KINDS.has(ev.kind)) continue; // pair retracted
    if (nowMs - ev.ts > PRESENCE_TTL_MS) continue; // stale
    out.push({
      actor: ev.actor,
      isAgent: ev.is_agent,
      kind: ev.kind,
      file: ev.file as string,
      symbol: ev.symbol,
      ts: ev.ts,
      color: presenceColorFor(ev.actor),
    });
  }
  // Newest first so pip stacks show the freshest peer's color on top.
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

/** Forgiving path match: the event path is usually repo-relative while the
 *  editor deals in absolute paths. Accept exact, suffix, or repo-join match. */
export function presenceForFile(
  entries: FilePresence[],
  repoRoot: string,
  filePath: string,
): FilePresence[] {
  if (!filePath || entries.length === 0) return [];
  const open = filePath.toLowerCase();
  const rel = repoRoot && filePath.startsWith(repoRoot + "/")
    ? filePath.slice(repoRoot.length + 1).toLowerCase()
    : open;
  return entries.filter((e) => {
    const f = e.file.toLowerCase();
    return f === open || f === rel || f.endsWith("/" + rel) || open.endsWith("/" + f);
  });
}

/** Whether two presence lists say the same thing, entry for entry. */
export function samePresence(a: FilePresence[], b: FilePresence[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.actor === y.actor &&
      x.file === y.file &&
      x.kind === y.kind &&
      x.symbol === y.symbol &&
      x.ts === y.ts &&
      x.isAgent === y.isAgent
    );
  });
}

async function refresh(repoRoot: string): Promise<void> {
  const s = stateFor(repoRoot);
  if (s.inFlight) return;
  s.inFlight = true;
  let next: FilePresence[];
  try {
    const view = await api.auraRadar(repoRoot, false);
    next = derivePresence(view.events ?? [], view.me, Date.now());
  } catch {
    // Radar unavailable (old CLI, no .aura) — show nothing rather than stale.
    next = [];
  } finally {
    s.inFlight = false;
  }
  // A read that found what the last one did leaves the snapshot alone, so a
  // quiet radar doesn't re-render every subscriber on every tick.
  if (samePresence(s.entries, next)) return;
  s.entries = next;
  for (const cb of s.subscribers) cb();
}

function startPolling(repoRoot: string): void {
  const s = stateFor(repoRoot);
  if (s.timer != null) return;
  void refresh(repoRoot);
  s.timer = window.setInterval(() => {
    if (document.hidden) return; // hold cadence while backgrounded
    void refresh(repoRoot);
  }, POLL_MS);
}

function stopPolling(repoRoot: string): void {
  const s = repos.get(repoRoot);
  if (!s || s.timer == null) return;
  window.clearInterval(s.timer);
  s.timer = null;
}

function subscribe(repoRoot: string, cb: () => void): () => void {
  const s = stateFor(repoRoot);
  s.subscribers.add(cb);
  if (s.subscribers.size === 1) startPolling(repoRoot);
  return () => {
    s.subscribers.delete(cb);
    if (s.subscribers.size === 0) stopPolling(repoRoot);
  };
}

const EMPTY: FilePresence[] = [];

/** Live presence entries for a repo. Subscribing starts the shared poll;
 *  the snapshot is a stable array reference that only changes on new data. */
export function useRadarPresence(repoRoot: string | null | undefined): FilePresence[] {
  const root = repoRoot ?? "";
  // Both callbacks are held per root. A fresh subscribe function on each
  // render makes React unsubscribe and subscribe again; with one subscriber
  // that stops the poll and starts it, and starting it reads the radar at
  // once — so every answer re-rendered, resubscribed and asked again, and the
  // radar was read back to back instead of every POLL_MS.
  const subscribeRoot = useCallback(
    (cb: () => void) => (root ? subscribe(root, cb) : () => {}),
    [root],
  );
  const snapshot = useCallback(() => (root ? stateFor(root).entries : EMPTY), [root]);
  const entries = useSyncExternalStore(subscribeRoot, snapshot);
  // Resume immediately when the window becomes visible again — the interval
  // skipped ticks while hidden, so the first foreground frame could be stale.
  useEffect(() => {
    if (!root) return;
    const onVis = () => {
      if (!document.hidden && stateFor(root).subscribers.size > 0) {
        void refresh(root);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [root]);
  return entries;
}
