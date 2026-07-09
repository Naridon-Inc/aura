// Subscriber-set store for live agent PTY sessions, keyed by session id.
// Each entry holds the running stack of Block envelopes (prompt / output
// / exit) for one (agent, repo) PTY. The AgentBlocksView renders from
// here; the AgentTerminalView reads the raw byte stream straight from
// the `agent-pty:<id>` event and doesn't need this store.
//
// Lifecycle:
//   1. First subscriber for a session id triggers a `agent_pty_replay`
//      backfill (in case the PTY was opened on a previous tab mount and
//      already has history) AND a tauri `listen` for `agent-block:<id>`.
//   2. Every BlockUpdate event is applied to the in-memory list.
//   3. Subscribers are reference-counted; when the last one detaches,
//      the listener is dropped. The block history stays cached so a
//      remount replays from memory without re-hitting the backend.

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, type BlockEnvelope, type BlockUpdate } from "./api";

type SessionState = {
  blocks: BlockEnvelope[];
};

type Entry = {
  state: SessionState;
  subs: Set<() => void>;
  unlisten: UnlistenFn | null;
  hydrating: Promise<void> | null;
};

const entries = new Map<string, Entry>();

function ensureEntry(sessionId: string): Entry {
  let e = entries.get(sessionId);
  if (e) return e;
  e = { state: { blocks: [] }, subs: new Set(), unlisten: null, hydrating: null };
  entries.set(sessionId, e);
  return e;
}

function emit(entry: Entry) {
  entry.subs.forEach((fn) => fn());
}

function applyUpdate(entry: Entry, ev: BlockUpdate) {
  const prev = entry.state.blocks;
  if (ev.op === "open") {
    // Idempotent — if a replay already brought this block in, don't dup.
    if (prev.some((b) => b.id === ev.block.id)) return;
    entry.state = { blocks: [...prev, ev.block] };
  } else if (ev.op === "close") {
    entry.state = {
      blocks: prev.map((b) => (b.id === ev.block.id ? ev.block : b)),
    };
  } else if (ev.op === "append") {
    entry.state = {
      blocks: prev.map((b) =>
        b.id === ev.block_id ? { ...b, text: appendCapped(b.text, ev.text) } : b,
      ),
    };
  }
  emit(entry);
}

// Per-block character cap. A long Claude run can stream MB into a
// single Output block (multi-file dumps, long traces). Without a cap
// the block text grows unbounded for the lifetime of the tab. When we
// overflow, prepend a "[…earlier output trimmed…]" marker and keep the
// most recent BLOCK_CHAR_CAP characters — the recent tail is what the
// user actually wants to read, the head is already past the scroll.
const BLOCK_CHAR_CAP = 256 * 1024;
const TRIM_MARKER = "\n[…earlier output trimmed…]\n";

function appendCapped(prev: string, next: string): string {
  const combined = prev + next;
  if (combined.length <= BLOCK_CHAR_CAP) return combined;
  const keep = BLOCK_CHAR_CAP - TRIM_MARKER.length;
  return TRIM_MARKER + combined.slice(combined.length - keep);
}

async function attach(sessionId: string, entry: Entry) {
  if (entry.unlisten) return;
  // Backfill first so any blocks emitted before we mounted are present
  // when the listener picks up. The replay returns the canonical list;
  // the listener only adds new updates after this point.
  if (!entry.hydrating) {
    entry.hydrating = (async () => {
      try {
        const replay = await api.agentPtyReplay(sessionId);
        // Merge with any pre-seeded blocks (e.g. carried over from a
        // stream tab via seedAgentSession). The seed represents prior
        // conversation; replay represents new PTY block updates emitted
        // before our listener registered. Dedupe by id, keeping seed
        // entries first so chronological order matches user expectation.
        const seeded = entry.state.blocks;
        if (seeded.length === 0) {
          entry.state = { blocks: replay };
        } else if (replay.length === 0) {
          // Keep seed as-is. Avoid emit() — no change.
          return;
        } else {
          const ids = new Set(seeded.map((b) => b.id));
          const extras = replay.filter((b) => !ids.has(b.id));
          entry.state = { blocks: [...seeded, ...extras] };
        }
        emit(entry);
      } catch {
        /* session might have closed mid-mount — leave blocks empty */
      }
    })();
  }
  await entry.hydrating;
  // Tauri's listen is async — register before any subsequent paint.
  entry.unlisten = await listen<BlockUpdate>(`agent-block:${sessionId}`, (e) => {
    applyUpdate(entry, e.payload);
  });
}

function detach(entry: Entry) {
  // Only tear down the listener when the last subscriber leaves; the
  // cached blocks stay so a remount doesn't re-flicker.
  if (entry.subs.size === 0 && entry.unlisten) {
    entry.unlisten();
    entry.unlisten = null;
  }
}

export function useAgentSession(sessionId: string | null): { blocks: BlockEnvelope[] } {
  const [, force] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    const entry = ensureEntry(sessionId);
    const fn = () => force((n) => n + 1);
    entry.subs.add(fn);
    attach(sessionId, entry).catch(() => {});
    return () => {
      entry.subs.delete(fn);
      detach(entry);
    };
  }, [sessionId]);

  if (!sessionId) return { blocks: [] };
  const entry = entries.get(sessionId);
  return { blocks: entry?.state.blocks ?? [] };
}

/** Drop all cached state for a session. Call when closing the agent
 *  PTY so a future re-spawn under the same id starts clean. */
export function forgetAgentSession(sessionId: string) {
  const e = entries.get(sessionId);
  if (e?.unlisten) e.unlisten();
  entries.delete(sessionId);
}

/** Pre-load a session with historical block envelopes. Used when a
 *  stream tab is converted into a PTY tab via "Open Terminal" — the
 *  prior conversation is materialised as completed blocks so toggling
 *  back to UI view shows the chat that came before, instead of an
 *  empty state. Subsequent live BlockUpdates from the PTY stack on
 *  top via the regular listener. */
export function seedAgentSession(
  sessionId: string,
  blocks: BlockEnvelope[],
) {
  const entry = ensureEntry(sessionId);
  // Treat the seed as authoritative for the *initial* render — if a
  // hydrating replay later returns blocks for the same session, the
  // listener path will reconcile via id-keyed open ops. We don't worry
  // about dedupe at seed time: this PTY is brand-new, so its native
  // replay buffer is empty.
  entry.state = { blocks: [...blocks] };
  emit(entry);
}
