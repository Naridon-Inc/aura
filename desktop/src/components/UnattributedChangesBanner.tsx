// Top-strip banner shown above WorkSurface whenever the agent-mutation
// guard fires `aura:agent-mutation-unattributed`. Each row represents a
// file an agent (Claude / Gemini / Codex / OpenCode) touched without a
// covering `aura_log_intent` entry, while an agent PTY was alive.
//
// Placement choice: we mount alongside AuraImpactsBanner at the top of
// the body slot (above PresetsBar + WorkSurface). The strip is the
// loudest surface short of a modal — anything quieter (status-bar chip,
// right-rail row) risks being ignored, and "agent mutated a file you
// didn't authorize" is exactly the situation the user must see.
//
// The strip auto-collapses to a single row + "+N more" when multiple
// mutations queue up, mirroring AuraImpactsBanner's visual language so
// the user reads it the same way.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, type UnattributedMutation } from "../lib/api";

type Props = {
  repoRoot: string;
};

// Self-heal pipeline: when a mutation arrives, ask the agent CLI to log
// intent itself before nagging the user. Each pending entry holds the
// nudge agent so we can show "Manager is asking Claude…" inline.
type PendingNudge = {
  mutation: UnattributedMutation;
  nudgedAgent: string | null; // null while the nudge RPC is still in flight
  startedAt: number;
};

// How long to wait before re-checking intent coverage after a mutation.
// MUST stay comfortably *inside* the backend's INTENT_WINDOW_S (30s):
// the guard auto-logs a covering stub intent synchronously inside the
// nudge RPC, so coverage is already present the moment the RPC returns —
// we wait only a short beat to let the intent-log write settle and give
// a live agent a moment to upgrade the stub to a real reason.
//
// The old value was 30_000 — exactly equal to INTENT_WINDOW_S — so by
// the time we re-checked, the stub we'd just logged had aged to the very
// edge of its own freshness window and any jitter pushed it out. That
// raced benign, already-captured edits into the red Revert/Accept banner
// (the autonomous capture is supposed to keep the user out of the loop).
const SELF_HEAL_VERIFY_MS = 4_000;

// Coalesce events arriving in rapid succession into one nudge. A
// multi-file edit (search/replace, formatter, scaffold) can fire dozens
// of FS events inside a few hundred ms — without batching we'd write
// one prompt per file into the agent PTY and bury the agent in noise.
const NUDGE_DEBOUNCE_MS = 1_500;

export function UnattributedChangesBanner({ repoRoot }: Props) {
  const [pending, setPending] = useState<Map<string, PendingNudge>>(new Map());
  const [queue, setQueue] = useState<UnattributedMutation[]>([]);
  const [acceptOpen, setAcceptOpen] = useState<UnattributedMutation | null>(
    null,
  );
  const [acceptText, setAcceptText] = useState("");
  const [busy, setBusy] = useState(false);

  // Mounted refs so async timer callbacks don't fire setState after
  // unmount when the user switches repos mid-nudge.
  const repoRootRef = useRef(repoRoot);
  repoRootRef.current = repoRoot;
  const seenRef = useRef<Set<string>>(new Set());

  // Coalescing buffer: events arriving inside NUDGE_DEBOUNCE_MS are
  // queued here and flushed as a single batch nudge.
  const batchBufRef = useRef<UnattributedMutation[]>([]);
  const batchTimerRef = useRef<number | null>(null);

  // Escalation path: move a pending mutation to the red strip.
  const escalate = useCallback((id: string) => {
    setPending((prev) => {
      const next = new Map(prev);
      const entry = next.get(id);
      if (!entry) return prev;
      next.delete(id);
      setQueue((q) => {
        if (q.some((p) => p.event_id === id)) return q;
        return [entry.mutation, ...q].slice(0, 50);
      });
      return next;
    });
  }, []);

  // Silent dismiss path: agent logged intent in time, just drop it.
  const heal = useCallback((id: string) => {
    setPending((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Subscribe to the backend event. New mutations go through self-heal
  // before they ever show up as a red banner — see PendingNudge.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    // Flush all buffered events as a single batched nudge. We dedupe
    // by path so a flurry of writes on the same file counts once.
    const flushBatch = () => {
      batchTimerRef.current = null;
      const drained = batchBufRef.current;
      batchBufRef.current = [];
      if (drained.length === 0) return;

      // Dedupe by path — keep the latest mutation per path.
      const byPath = new Map<string, UnattributedMutation>();
      for (const m of drained) byPath.set(m.path, m);
      const batch = Array.from(byPath.values());

      const root = repoRootRef.current;
      (async () => {
        // Coverage is the single source of truth for heal-vs-escalate.
        // We schedule it once per batch, a short beat after the nudge, so
        // the freshly auto-logged stub is comfortably inside its window.
        // Runs regardless of the nudge outcome — a null nudge only means
        // "no in-app PTY to talk to", NOT "uncovered": an external agent's
        // edit may already be attributed via the loopback-hook capture, a
        // prior stub, or the user's own recent intent.
        const verifyCoverage = () =>
          window.setTimeout(() => {
            void (async () => {
              for (const m of batch) {
                try {
                  const covered = await api.agentGuardIntentCovers(root, m.path);
                  if (covered) heal(m.event_id);
                  else escalate(m.event_id);
                } catch {
                  escalate(m.event_id);
                }
              }
            })();
          }, SELF_HEAL_VERIFY_MS);

        try {
          const res = await api.agentGuardSelfHealNudge(
            root,
            batch.map((m) => ({
              path: m.path,
              kind: m.kind as "create" | "modify" | "remove",
            })),
          );
          // Truthy → an in-app agent was nudged and a stub intent was
          // auto-logged for these paths; surface which agent inline while
          // the brief self-heal window runs.
          if (res) {
            setPending((prev) => {
              const next = new Map(prev);
              for (const m of batch) {
                const cur = next.get(m.event_id);
                if (cur) next.set(m.event_id, { ...cur, nudgedAgent: res.agent_id });
              }
              return next;
            });
          }
          verifyCoverage();
        } catch {
          // Nudge RPC itself failed — still verify coverage before
          // escalating; the edit may already be attributed.
          verifyCoverage();
        }
      })();
    };

    (async () => {
      unlisten = await listen<UnattributedMutation>(
        "aura:agent-mutation-unattributed",
        (e) => {
          const m = e.payload;
          if (seenRef.current.has(m.event_id)) return;
          seenRef.current.add(m.event_id);

          setPending((prev) => {
            if (prev.has(m.event_id)) return prev;
            const next = new Map(prev);
            next.set(m.event_id, {
              mutation: m,
              nudgedAgent: null,
              startedAt: Date.now(),
            });
            return next;
          });

          // Buffer + debounce: one nudge per batch, not per file.
          batchBufRef.current.push(m);
          if (batchTimerRef.current != null) {
            window.clearTimeout(batchTimerRef.current);
          }
          batchTimerRef.current = window.setTimeout(
            flushBatch,
            NUDGE_DEBOUNCE_MS,
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
  }, [escalate, heal]);

  // Boot/teardown the backend guard when the workspace changes. Start
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

  const dismiss = useCallback((id: string) => {
    setQueue((prev) => prev.filter((p) => p.event_id !== id));
  }, []);

  const revert = useCallback(
    async (m: UnattributedMutation) => {
      setBusy(true);
      try {
        await api.agentGuardRevertFromSnapshot(repoRoot, m.path);
        dismiss(m.event_id);
      } catch (err) {
        // Surface the error in-place; the user can still try Accept or
        // Dismiss. We append the message inline rather than popping a
        // toast because the banner is the user's current focus.
        // eslint-disable-next-line no-console
        console.warn("[guard] revert failed:", err);
        alert(`Revert failed: ${err}`);
      } finally {
        setBusy(false);
      }
    },
    [repoRoot, dismiss],
  );

  const openAccept = useCallback((m: UnattributedMutation) => {
    setAcceptOpen(m);
    setAcceptText("");
  }, []);

  const confirmAccept = useCallback(async () => {
    if (!acceptOpen) return;
    const text = acceptText.trim();
    if (!text) return;
    setBusy(true);
    try {
      await api.agentGuardAcceptWithIntent(
        repoRoot,
        acceptOpen.path,
        text,
        acceptOpen.agent_id || undefined,
      );
      dismiss(acceptOpen.event_id);
      setAcceptOpen(null);
      setAcceptText("");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[guard] accept failed:", err);
      alert(`Accept failed: ${err}`);
    } finally {
      setBusy(false);
    }
  }, [acceptOpen, acceptText, repoRoot, dismiss]);

  const pendingList = Array.from(pending.values());
  if (queue.length === 0 && pendingList.length === 0) return null;
  const top = queue[0];
  const more = queue.length - 1;
  const pendingTop = pendingList[0];
  const pendingMore = pendingList.length - 1;

  return (
    <>
      {pendingTop && (
        <div
          className="flex items-center gap-2 h-6 px-3 text-[11px] border-b"
          // "A change landed that nobody has explained yet" is the attention
          // state, which is the amber slot. `--color-yellow` is defined by no
          // pack, so every one of these `color-mix()` calls was invalid at
          // computed-value time — the strip rendered with no wash, no edge and
          // inherited ink, i.e. invisible as a warning.
          style={{
            background:
              "color-mix(in oklab, var(--color-amber) 10%, transparent)",
            borderColor:
              "color-mix(in oklab, var(--color-amber) 32%, transparent)",
            color: "var(--color-amber)",
          }}
          role="status"
          title="Aura is asking the AI to explain this change before flagging it to you"
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ background: "var(--color-amber)" }}
          />
          <span className="font-medium uppercase tracking-wide text-[9.5px]">
            Checking
          </span>
          <span className="font-mono truncate">
            {shortPath(pendingTop.mutation.path)}
          </span>
          <span className="text-text-3 truncate flex-1">
            — Aura asking{" "}
            {pendingTop.nudgedAgent ||
              pendingTop.mutation.agent_id ||
              "the AI"}{" "}
            to explain the change…
          </span>
          {pendingMore > 0 && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-medium"
              style={{
                background:
                  "color-mix(in oklab, currentColor 14%, transparent)",
              }}
            >
              +{pendingMore} more
            </span>
          )}
        </div>
      )}
      {top && (
      <div
        className="flex items-center gap-2 h-7 px-3 text-[11.5px] border-b"
        style={{
          background: "color-mix(in oklab, var(--color-red) 14%, transparent)",
          borderColor:
            "color-mix(in oklab, var(--color-red) 40%, transparent)",
          color: "var(--color-red)",
        }}
        role="alert"
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: "var(--color-red)" }}
        />
        <span className="font-medium uppercase tracking-wide text-[10px]">
          Unexplained
        </span>
        <span className="font-mono truncate">{shortPath(top.path)}</span>
        <span className="text-text-3 truncate flex-1">
          — {labelFor(top)}
        </span>
        {more > 0 && (
          <span
            className="text-[10.5px] px-1.5 py-0.5 rounded font-medium"
            style={{
              background: "color-mix(in oklab, currentColor 14%, transparent)",
            }}
          >
            +{more} more
          </span>
        )}
        <span className="text-text-4 tabular-nums text-[10.5px]">
          {relAge(top.ts)}
        </span>
        <button
          type="button"
          onClick={() => revert(top)}
          disabled={busy}
          className="text-[10.5px] px-2 py-0.5 rounded font-medium hover:opacity-80 disabled:opacity-50"
          style={{
            background: "color-mix(in oklab, currentColor 18%, transparent)",
          }}
          title="Bring this file back to its last save point"
        >
          Revert
        </button>
        <button
          type="button"
          onClick={() => openAccept(top)}
          disabled={busy}
          className="text-[10.5px] px-2 py-0.5 rounded font-medium hover:opacity-80 disabled:opacity-50"
          style={{
            background: "color-mix(in oklab, currentColor 14%, transparent)",
          }}
          title="Add a reason for this change and keep the edit"
        >
          Accept
        </button>
        <button
          type="button"
          onClick={() => dismiss(top.event_id)}
          className="text-[12px] w-5 h-5 rounded hover:bg-bg-2 transition-colors text-text-4 hover:text-text-1"
          title="Dismiss this alert"
        >
          ✕
        </button>
      </div>
      )}

      {acceptOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          role="dialog"
          aria-modal="true"
        >
          <div
            className="bg-bg-1 border border-line rounded-md shadow-xl p-4 w-[480px] max-w-[90vw] flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[12.5px] font-medium text-text-1">
              Accept agent change
            </div>
            <div className="text-[11.5px] text-text-3">
              <div className="font-mono truncate">{shortPath(acceptOpen.path)}</div>
              <div className="mt-0.5">{labelFor(acceptOpen)}</div>
            </div>
            <textarea
              autoFocus
              value={acceptText}
              onChange={(e) => setAcceptText(e.target.value)}
              placeholder="What was this change for? (one line)"
              rows={3}
              className="text-[12px] bg-bg-2 border border-line rounded px-2 py-1.5 font-mono text-text-1 resize-none focus:outline-none focus:ring-1 focus:ring-accent"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void confirmAccept();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setAcceptOpen(null);
                }
              }}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setAcceptOpen(null)}
                disabled={busy}
                className="text-[11.5px] px-3 py-1 rounded hover:bg-bg-2 text-text-2 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmAccept}
                disabled={busy || acceptText.trim().length === 0}
                className="text-[11.5px] px-3 py-1 rounded bg-accent text-bg-1 font-medium hover:opacity-90 disabled:opacity-50"
              >
                Add note + keep
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function shortPath(p: string): string {
  // Strip leading repo root portions; show the last 3 segments for
  // signal without overflowing the strip.
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return "…/" + parts.slice(-3).join("/");
}

function labelFor(m: UnattributedMutation): string {
  const verb =
    m.kind === "create" ? "created" : m.kind === "remove" ? "deleted" : "modified";
  const who = m.agent_id || m.live_agents || "agent";
  return `${who} ${verb} this file with no intent logged`;
}

function relAge(unixSecs: number): string {
  const ageS = Math.max(0, Math.floor(Date.now() / 1000 - unixSecs));
  if (ageS < 60) return `${ageS}s`;
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m`;
  if (ageS < 86400) return `${Math.floor(ageS / 3600)}h`;
  return `${Math.floor(ageS / 86400)}d`;
}
