// Subscriber-set store for AuraWatch nudges + applied intents, keyed
// by the same sanitized channel id agentStreamStore uses. Mirrors the
// store-shape pattern: per-channel cache, refcounted listener attach.
//
// We hold pending nudges + a small history of applied intents. The
// AuraWatchBubble grabs `pending` via useAuraWatch(channel) and
// renders one card per nudge — accept/dismiss flips the entry out.

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { type AppliedIntent, type Nudge } from "./api";

type Entry = {
  pending: Nudge[];
  applied: AppliedIntent[];
  subs: Set<() => void>;
  unlistenNudge: UnlistenFn | null;
  unlistenApplied: UnlistenFn | null;
};

const entries = new Map<string, Entry>();

function ensure(channel: string): Entry {
  let e = entries.get(channel);
  if (e) return e;
  e = {
    pending: [],
    applied: [],
    subs: new Set(),
    unlistenNudge: null,
    unlistenApplied: null,
  };
  entries.set(channel, e);
  return e;
}

function emit(e: Entry) {
  e.subs.forEach((fn) => fn());
}

async function attach(channel: string, e: Entry) {
  e.unlistenNudge = await listen<Nudge>(
    `aurawatch:nudge:${channel}`,
    (ev) => {
      e.pending = [...e.pending, ev.payload];
      emit(e);
    },
  );
  e.unlistenApplied = await listen<AppliedIntent>(
    `aurawatch:applied:${channel}`,
    (ev) => {
      e.applied = [ev.payload, ...e.applied].slice(0, 20);
      emit(e);
    },
  );
}

export function useAuraWatch(channel: string | null): {
  pending: Nudge[];
  applied: AppliedIntent[];
} {
  const [, force] = useState(0);
  useEffect(() => {
    if (!channel) return;
    const e = ensure(channel);
    const fn = () => force((n) => n + 1);
    e.subs.add(fn);
    if (!e.unlistenNudge) attach(channel, e).catch(() => {});
    return () => {
      e.subs.delete(fn);
      if (e.subs.size === 0) {
        if (e.unlistenNudge) e.unlistenNudge();
        if (e.unlistenApplied) e.unlistenApplied();
        e.unlistenNudge = null;
        e.unlistenApplied = null;
      }
    };
  }, [channel]);

  if (!channel) return { pending: [], applied: [] };
  const e = entries.get(channel);
  return { pending: e?.pending ?? [], applied: e?.applied ?? [] };
}

export function dismissNudge(channel: string, id: string) {
  const e = entries.get(channel);
  if (!e) return;
  e.pending = e.pending.filter((n) => n.id !== id);
  emit(e);
}
