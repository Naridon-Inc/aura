//! Leaf owner of the in-flight stream blocks.
//!
//! Every streamed token used to land in `useState` on `ManagerChatView` — a
//! 5,000-line component that also maps the whole settled timeline. One
//! `text_delta` therefore re-rendered the entire conversation (re-parsing the
//! markdown of every prior turn) just to append two characters to the live
//! bubble. That is the single most-felt lag in the app while a reply streams.
//!
//! The blocks now live in a tiny external store the *leaf* subscribes to, so a
//! token re-renders only the live bubble and the settled timeline above it
//! stays mounted and untouched. The parent still needs two coarse facts — "is
//! anything streaming" and "which tool is running" — so the store publishes
//! those as a separately-memoized snapshot whose identity only changes when
//! one of them actually changes. `useSyncExternalStore` bails out on an
//! identical snapshot, so the parent re-renders on tool boundaries (a handful
//! per turn) instead of on every token.
//!
//! Nothing about the rendering changed: the same `StreamingBubble` in the same
//! `aria-live` wrapper, and the scroll-to-bottom pin the parent used to run off
//! its `streamBlocks` dependency now fires from this leaf's effect — same
//! moment (post-commit, after the DOM grew), same guard.

import { useEffect, useSyncExternalStore } from "react";

import { StreamingBubble } from "./ToolCard";
import type { StreamBlock } from "./types";

/** A tool block that is still waiting on its `tool_result`. */
export type RunningToolBlock = StreamBlock & { kind: "tool" };

/** The parent-visible summary of the live stream. Deliberately coarse: it
 *  changes a few times per turn (first block in, tool starts, tool ends, turn
 *  ends) instead of once per token. */
export type StreamCoarse = {
  /** True while any live block is mounted — the old `streamBlocks.length > 0`. */
  hasBlocks: boolean;
  /** The last tool block with no result yet: the command running right now. */
  runningTool: RunningToolBlock | null;
};

/** Shared empty array so a reset while already empty is a genuine no-op (no
 *  notify, no re-render) rather than a fresh `[]` identity. */
const NO_BLOCKS: StreamBlock[] = [];

export type StreamStore = {
  getBlocks: () => StreamBlock[];
  getCoarse: () => StreamCoarse;
  subscribe: (onChange: () => void) => () => void;
  /** Apply the same reducer shape the old `setStreamBlocks(prev => …)` calls
   *  used. A reducer that returns the previous array (e.g. `attachResult` for
   *  an unknown tool id) notifies nobody. */
  apply: (update: (prev: StreamBlock[]) => StreamBlock[]) => void;
  /** Retire the live blocks — the old `setStreamBlocks([])`. */
  reset: () => void;
};

export function createStreamStore(): StreamStore {
  let blocks: StreamBlock[] = NO_BLOCKS;
  let coarse: StreamCoarse = { hasBlocks: false, runningTool: null };
  const listeners = new Set<() => void>();

  // Recompute the coarse snapshot, but keep the SAME object when nothing the
  // parent cares about moved — `useSyncExternalStore` compares snapshots with
  // `Object.is`, so a stable identity is what keeps the parent out of the
  // per-token render path. `runningTool` identity is stable across text
  // deltas because `upsertText` only copies the array, never the tool blocks.
  function recomputeCoarse(): void {
    let running: RunningToolBlock | null = null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!;
      if (b.kind === "tool" && !b.result) {
        running = b;
        break;
      }
    }
    const hasBlocks = blocks.length > 0;
    if (hasBlocks === coarse.hasBlocks && running === coarse.runningTool) return;
    coarse = { hasBlocks, runningTool: running };
  }

  function apply(update: (prev: StreamBlock[]) => StreamBlock[]): void {
    const next = update(blocks);
    if (next === blocks) return;
    blocks = next;
    recomputeCoarse();
    for (const fn of listeners) fn();
  }

  return {
    getBlocks: () => blocks,
    getCoarse: () => coarse,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    apply,
    reset: () => apply(() => NO_BLOCKS),
  };
}

/** Subscribe to the coarse summary. Re-renders the caller only when
 *  `hasBlocks` or the running tool changes — never per token. */
export function useStreamCoarse(store: StreamStore): StreamCoarse {
  return useSyncExternalStore(store.subscribe, store.getCoarse);
}

/** The live bubble. This is the ONLY component that re-renders per token. */
export function StreamingBlocks({
  store,
  streaming,
  onAdvance,
}: {
  store: StreamStore;
  /** The turn is still running — drives the char-drip + trailing cursor. */
  streaming: boolean;
  /** Re-pin the scroller to the bottom. Called post-commit, exactly where the
   *  parent's old `streamBlocks`-keyed effect ran. Must be referentially
   *  stable or the effect fires on every parent render. */
  onAdvance: () => void;
}) {
  const blocks = useSyncExternalStore(store.subscribe, store.getBlocks);
  // Runs after the new text is in the DOM, so `scrollHeight` already includes
  // it — same ordering the parent effect had.
  useEffect(() => {
    onAdvance();
  }, [blocks, onAdvance]);
  if (blocks.length === 0) return null;
  return (
    // Polite, non-atomic live region: screen readers announce the assistant's
    // reply as it streams in (WCAG 2.2 § 4.1.3 Status Messages) without
    // re-reading the whole turn on every token.
    <div aria-live="polite" aria-atomic="false" aria-relevant="additions text">
      <StreamingBubble
        blocks={blocks}
        streaming={streaming}
        // No "Aura" brand row — kept off the live turn too so the stream reads
        // identically to a settled one (the tab carries the brand).
        identity={false}
      />
    </div>
  );
}
