// Call-activity ring buffer.
//
// Tracks discrete events during the active huddle: participant joins,
// participant leaves, screenshare start, screenshare stop. The
// VoiceDockPanel's "Activity" popover reads from here.
//
// Why a separate store (not callStore.snapshot): the event log is
// time-ordered and append-only; folding it into the snapshot would
// either force the snapshot to mutate references on every event (ugly)
// or force consumers to memo carefully. A small dedicated store with
// its own useSyncExternalStore hook is cleaner.
//
// Bounded — cap at MAX_ENTRIES. Cleared on clearCall via the existing
// `aura:huddle-state {channel: null}` broadcast.

import { useSyncExternalStore } from "react";

const MAX_ENTRIES = 50;

export type CallActivityKind =
  | "join"
  | "leave"
  | "screenshare-start"
  | "screenshare-stop";

export type CallActivityEntry = {
  /** Stable id — timestamp + counter so React keys never collide. */
  id: string;
  kind: CallActivityKind;
  /** Display name of the participant the event references. */
  participantName: string;
  /** True when the entry is about the local user. */
  isLocal: boolean;
  /** Unix millis the event was recorded at — used for "2m ago". */
  ts: number;
};

let entries: CallActivityEntry[] = [];
let nextId = 1;
const subs = new Set<() => void>();

function emit(): void {
  for (const fn of subs) fn();
}

export function recordCallActivity(
  kind: CallActivityKind,
  participantName: string,
  isLocal: boolean,
): void {
  const entry: CallActivityEntry = {
    id: `${Date.now()}.${nextId++}`,
    kind,
    participantName: participantName || "Someone",
    isLocal,
    ts: Date.now(),
  };
  // Dedupe noisy bursts: if the same kind for the same participant
  // landed in the last 1500ms, drop it. LiveKit can emit a
  // disconnected+connected pair on a transient network blip; the
  // activity log should reflect the user-visible sequence, not the
  // SFU's plumbing.
  const recent = entries[entries.length - 1];
  if (
    recent &&
    recent.kind === kind &&
    recent.participantName === participantName &&
    Date.now() - recent.ts < 1500
  ) {
    return;
  }
  entries = [...entries.slice(-(MAX_ENTRIES - 1)), entry];
  emit();
}

export function clearCallActivity(): void {
  if (entries.length === 0) return;
  entries = [];
  emit();
}

function getActivity(): CallActivityEntry[] {
  return entries;
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function useCallActivity(): CallActivityEntry[] {
  return useSyncExternalStore(subscribe, getActivity, getActivity);
}

// `formatRelativeAge` lived here: the app's one *shared* age formatter, with
// zero callers — which is how it kept a ladder that stopped at hours, so
// anything older than a day would have read "168h ago". Every surface rolled
// its own instead. The ladder is lib/relativeTime now, and it is used.
