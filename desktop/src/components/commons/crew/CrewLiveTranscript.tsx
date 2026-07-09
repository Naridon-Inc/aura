// Crew · Watch live — open a WORKING node into the agent that's building it.
//
// A crew node with status `working` means a lane is actively running it: the
// native runner (`loop_run_native`) claimed the node and handed its objective
// to one of the orchestrator's lanes, which streams Aura's own brain
// (`Brain::chat`) and accumulates every chunk into that lane's live transcript.
// This panel is the window onto that stream — so a vibecoder can WATCH the
// agent work, not just read the static spec.
//
// How the node finds its lane (the real linkage, no faking):
//   • `loop_run_native` dispatches each ready node as a lane whose
//     `spec.label` is the node's title and whose `spec.objective` opens with
//     that title (`build_objective`). It does NOT stamp the lane id back onto
//     the graph node, so we recover the link by title.
//   • `orchestratorListActive()` returns every in-flight lane (each carrying
//     its live `transcript`, `status`, `wave_id` and `spec`). We pick the lane
//     whose label matches this node's title — preferring one still running,
//     else the most recently started — and that's the agent on this node.
//   • Once we know the lane's `wave_id`, we subscribe to
//     `orchestrator-wave:<wave_id>`, the same event the dispatcher emits on
//     every chunk, and re-read our lane from each snapshot. The transcript
//     grows live in front of the user.
//
// Self-contained: it depends only on `api` + the Tauri event bus, never on
// CrewSurface or any parent surface. Closes on Esc, the X, or a click on the
// backdrop.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2, RadioTower, X } from "lucide-react";

import { api, type LaneOutcome, type LaneStatus, type WaveOutcome } from "../../../lib/api";

// A lane is "still live" while it hasn't reached a terminal state — those are
// the ones whose agent is genuinely on the node right now.
const TERMINAL: ReadonlySet<LaneStatus> = new Set<LaneStatus>([
  "done",
  "failed",
  "cancelled",
  "conflict",
]);
const isTerminal = (s: LaneStatus) => TERMINAL.has(s);

// Plain-language word for the lane's machine state — no jargon on the panel.
const STATUS_WORD: Record<LaneStatus, string> = {
  queued: "Queued — about to start",
  running: "Working on it now",
  done: "Finished",
  conflict: "Paused — another lane touched the same files",
  cancelled: "Stopped",
  failed: "Hit a problem",
};

// Match a lane to a node by the title the runner stamped onto the lane. The
// runner sets `spec.label` to the node's title verbatim; older/edge dispatches
// only carry it at the head of `spec.objective`, so we fall back to that.
function laneMatchesTitle(lane: LaneOutcome, title: string): boolean {
  const t = title.trim();
  if (!t) return false;
  const label = (lane.spec.label ?? "").trim();
  if (label && label === t) return true;
  const objective = (lane.spec.objective ?? "").trim();
  return objective.startsWith(t);
}

// From all in-flight lanes, the one that belongs to this node: a still-running
// match wins over a finished one; among equals, the most recently started.
function pickLane(lanes: LaneOutcome[], title: string): LaneOutcome | null {
  const matches = lanes.filter((l) => laneMatchesTitle(l, title));
  if (matches.length === 0) return null;
  const live = matches.filter((l) => !isTerminal(l.status));
  const pool = live.length > 0 ? live : matches;
  return pool.reduce((best, l) =>
    l.started_at > best.started_at ? l : best,
  );
}

export function CrewLiveTranscript({
  nodeTitle,
  onClose,
}: {
  /** The working node's title — the key we link to its live lane. */
  nodeTitle: string;
  onClose: () => void;
}) {
  // `null` = still looking; a lane = found and (maybe) streaming; the
  // `notFound` flag distinguishes "no lane for this node" from "still loading".
  const [lane, setLane] = useState<LaneOutcome | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waveIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLPreElement | null>(null);
  // Pin the title for the lifetime of this panel so a board refresh under it
  // never re-points us at a different lane.
  const title = useMemo(() => nodeTitle, [nodeTitle]);

  // Close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // First pass: find this node's lane among all in-flight lanes, so we learn
  // its wave id and can subscribe to the live feed.
  useEffect(() => {
    let cancelled = false;
    void api
      .orchestratorListActive()
      .then((lanes) => {
        if (cancelled) return;
        const found = pickLane(lanes, title);
        if (found) {
          waveIdRef.current = found.wave_id;
          setLane(found);
        } else {
          setNotFound(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [title]);

  // Live feed: once we know the wave, subscribe to its chunk events and re-pick
  // our lane from each snapshot, so the transcript grows in front of the user.
  // The dispatcher emits the whole `WaveOutcome` on every chunk.
  useEffect(() => {
    const waveId = lane?.wave_id;
    if (!waveId) return;
    let unsub: (() => void) | null = null;
    void (async () => {
      unsub = await listen<WaveOutcome>(
        `orchestrator-wave:${waveId}`,
        (evt) => {
          const next = pickLane(evt.payload.lanes, title);
          if (next) setLane(next);
        },
      );
    })();
    return () => {
      if (unsub) unsub();
    };
  }, [lane?.wave_id, title]);

  // Keep the transcript pinned to the newest output as it streams in.
  const transcript = lane?.transcript ?? "";
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  const stopWatching = useCallback(() => onClose(), [onClose]);

  const live = lane ? !isTerminal(lane.status) : false;

  return (
    <div
      className="absolute inset-0 z-[60] flex items-stretch justify-end bg-black/30 backdrop-blur-[1px]"
      onPointerDown={(e) => {
        // Click on the dim backdrop (not the panel) closes.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex h-full w-[420px] max-w-[90vw] flex-col border-l border-line bg-bg-content shadow-[var(--shadow-modal)]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Header — what we're watching + a live pulse, with a close button. */}
        <div className="flex items-start gap-2.5 border-b border-line-soft px-4 py-3">
          <span
            className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg"
            style={{
              background: live
                ? "color-mix(in srgb, var(--color-accent) 14%, transparent)"
                : "var(--color-bg-2)",
              color: live ? "var(--color-accent)" : "var(--color-text-4)",
            }}
          >
            {live ? (
              <RadioTower size={15} className="animate-pulse" />
            ) : (
              <RadioTower size={15} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-text-5">
              Watching live
            </div>
            <div className="truncate text-[13px] font-semibold leading-tight text-text-1">
              {title}
            </div>
            {lane ? (
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-4">
                {live ? (
                  <Loader2 size={11} className="animate-spin text-accent" />
                ) : null}
                <span>{STATUS_WORD[lane.status]}</span>
                {lane.provider_id ? (
                  <span className="text-text-5">· {lane.provider_id}</span>
                ) : null}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={stopWatching}
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-text-4 hover:bg-bg-2 hover:text-text-1"
            title="Close"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body — the live transcript, or an honest empty/loading/error read. */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {error ? (
            <CenteredNote
              title="Couldn't open the live view"
              body={error}
            />
          ) : notFound ? (
            <CenteredNote
              title="No live agent to watch"
              body="This task shows as in progress, but there's no running agent stream behind it right now. It may have just finished, or the run was started elsewhere and isn't streaming to this window."
            />
          ) : !lane ? (
            <CenteredNote
              loading
              title="Finding the agent on this task…"
              body="Linking this task to the agent that's building it."
            />
          ) : transcript ? (
            <pre
              ref={scrollRef}
              className="h-full overflow-auto whitespace-pre-wrap break-words px-4 py-3 text-[11.5px] leading-relaxed text-text-2"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {transcript}
            </pre>
          ) : (
            <CenteredNote
              loading={live}
              title={live ? "Warming up…" : "Nothing came through"}
              body={
                live
                  ? "The agent is on it; its first output will appear here any moment."
                  : "This run produced no visible output before it settled."
              }
            />
          )}
        </div>

        {/* Footer — the one steering control we can offer honestly today:
            stop the agent on this node. Wired to the same lane-cancel the
            orchestrator surface uses, so it kills the real brain session. */}
        {lane && live ? (
          <div className="flex items-center justify-between gap-2 border-t border-line-soft px-4 py-2.5">
            <span className="text-[10.5px] text-text-5">
              Streaming the agent's own output, live.
            </span>
            <StopLaneButton laneId={lane.lane_id} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Stop the agent on this node — cancels its lane (kills the brain session and
// frees the files it held). Optimistic: once asked, the lane flips to
// `cancelled` on the next wave snapshot and the panel's live state follows.
function StopLaneButton({ laneId }: { laneId: string }) {
  const [stopping, setStopping] = useState(false);
  const stop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await api.orchestratorCancelLane(laneId);
    } catch {
      // Best-effort — if the cancel didn't land the lane stays live and the
      // user can try again; surfacing a toast here would need a parent seam.
      setStopping(false);
    }
  }, [laneId, stopping]);
  return (
    <button
      type="button"
      onClick={stop}
      disabled={stopping}
      className="inline-flex items-center gap-1 rounded-full border border-line-soft px-2.5 py-1 text-[10.5px] font-medium text-text-3 hover:border-text-3 hover:text-text-1 disabled:opacity-60"
      title="Stop this agent — ends its session and frees the files it was editing"
    >
      {stopping ? <Loader2 size={11} className="animate-spin" /> : null}
      {stopping ? "Stopping…" : "Stop this agent"}
    </button>
  );
}

function CenteredNote({
  title,
  body,
  loading,
}: {
  title: string;
  body: string;
  loading?: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      {loading ? (
        <Loader2 size={18} className="animate-spin text-text-4" />
      ) : null}
      <div className="text-[12.5px] font-medium text-text-2">{title}</div>
      <div className="max-w-[280px] text-[11.5px] leading-snug text-text-4">
        {body}
      </div>
    </div>
  );
}
