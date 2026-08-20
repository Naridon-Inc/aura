// Headless. Renders nothing, ever.
//
// This used to be UnattributedChangesBanner: a red strip at the top of
// the app, one row per file an agent touched without a covering
// `aura_log_intent`, offering Revert / Accept. It was the loudest
// surface short of a modal, on purpose.
//
// That was the wrong call. Attributing a change is Aura's job, not a
// question to interrupt someone with — and in practice the strip fired
// on bursts (a build, a formatter, a multi-file edit) and stacked up
// "+49 more" rows that sat there for a day. The backend already knows
// how to write a covering reason on its own: the session's own prompt
// first, Aura's brain reading the diff second, an honest stub last.
//
// So the flow is now: watch, batch, capture, done. The record still
// exists — every captured change lands in `.aura/intent_log.jsonl` with
// a `source` saying where the reason came from, and the commit-time
// gate is still the thing that stops unaccounted work. It just doesn't
// stand in front of the user any more.

import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, type UnattributedMutation } from "../lib/api";

type Props = {
  repoRoot: string;
};

// Coalesce events arriving in rapid succession into one capture. A
// multi-file edit (search/replace, formatter, scaffold) can fire dozens
// of FS events inside a few hundred ms — one capture per file would
// write a wall of near-identical intent rows.
const BATCH_DEBOUNCE_MS = 1_500;

export function AgentMutationGuard({ repoRoot }: Props) {
  const repoRootRef = useRef(repoRoot);
  repoRootRef.current = repoRoot;

  // Paths already handed to the backend, so a re-fired FS event for the
  // same write doesn't book a second capture for it.
  const seenRef = useRef<Set<string>>(new Set());
  const batchBufRef = useRef<UnattributedMutation[]>([]);
  const batchTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    const flushBatch = () => {
      batchTimerRef.current = null;
      const drained = batchBufRef.current;
      batchBufRef.current = [];
      if (drained.length === 0) return;

      // Dedupe by path — a flurry of writes on one file counts once.
      const byPath = new Map<string, UnattributedMutation>();
      for (const m of drained) byPath.set(m.path, m);

      const root = repoRootRef.current;
      void api
        .agentGuardSelfHealNudge(
          root,
          Array.from(byPath.values()).map((m) => ({
            path: m.path,
            kind: m.kind as "create" | "modify" | "remove",
          })),
        )
        // Capture is best-effort and silent by design. A failure here
        // means this batch has no reason recorded yet, which the
        // commit-time gate will still catch — it is not something to
        // interrupt the user over.
        .catch(() => {});
    };

    (async () => {
      unlisten = await listen<UnattributedMutation>(
        "aura:agent-mutation-unattributed",
        (e) => {
          const m = e.payload;
          if (seenRef.current.has(m.event_id)) return;
          seenRef.current.add(m.event_id);

          batchBufRef.current.push(m);
          if (batchTimerRef.current != null) {
            window.clearTimeout(batchTimerRef.current);
          }
          batchTimerRef.current = window.setTimeout(
            flushBatch,
            BATCH_DEBOUNCE_MS,
          );
        },
      );
    })();

    return () => {
      if (unlisten) unlisten();
      if (batchTimerRef.current != null) {
        window.clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
    };
  }, []);

  // Boot/teardown the backend watcher when the workspace changes. Start
  // is idempotent on the Rust side — re-calling it on the same root is
  // a no-op.
  useEffect(() => {
    if (!repoRoot) return;
    api.agentGuardStart(repoRoot).catch(() => {
      /* best effort — guard outage shouldn't break the workspace */
    });
    return () => {
      api.agentGuardStop(repoRoot).catch(() => {});
    };
  }, [repoRoot]);

  return null;
}
