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
// CrewSurface or any parent surface. It is the library's right-hand sheet, so
// Esc, the X and a click on the backdrop all close it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { RadioTower } from "lucide-react";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../../ui/sheet";
import { EmptyState, ErrorState, LoadingState } from "../../ui/state";
import { CodeMessage } from "../../ui/transcript-content";
import "../../ui/crew-live.css";

import { api, type LaneOutcome, type LaneStatus, type WaveOutcome } from "../../../lib/api";
import { WORK_STATE, laneState } from "../../../lib/workState";

// A lane is "still live" while it hasn't reached a terminal state — those are
// the ones whose agent is genuinely on the node right now.
const TERMINAL: ReadonlySet<LaneStatus> = new Set<LaneStatus>([
  "done",
  "failed",
  "cancelled",
  "conflict",
]);
const isTerminal = (s: LaneStatus) => TERMINAL.has(s);

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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Pin the title for the lifetime of this panel so a board refresh under it
  // never re-points us at a different lane.
  const title = useMemo(() => nodeTitle, [nodeTitle]);

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
    const el = scrollRef.current?.querySelector("pre");
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  const live = lane ? !isTerminal(lane.status) : false;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="ui-crew-live">
        <SheetHeader>
          <SheetDescription className="ui-crew-live-kicker" data-live={live ? "" : undefined}>
            <RadioTower aria-hidden />
            Watching live
          </SheetDescription>
          <SheetTitle title={title}>{title}</SheetTitle>
          {lane ? (
            <p className="ui-crew-live-state">
              {live ? <AsciiSpinner size={10} /> : null}
              {WORK_STATE[laneState(lane.status)].hint}
              {lane.provider_id ? <span>· {lane.provider_id}</span> : null}
            </p>
          ) : null}
        </SheetHeader>

        {/* The live transcript, or an honest empty/loading/error read. */}
        <div className="ui-crew-live-body" ref={scrollRef}>
          {error ? (
            <ErrorState title="Couldn't open the live view" message={error} />
          ) : notFound ? (
            <EmptyState
              icon={RadioTower}
              title="No live agent to watch"
              body="This task shows as in progress, but there's no running agent stream behind it right now. It may have just finished, or the run was started elsewhere and isn't streaming to this window."
            />
          ) : !lane ? (
            <LoadingState
              size="md"
              label="Finding the agent on this task…"
              footnote="Linking this task to the agent that's building it."
            />
          ) : transcript ? (
            <CodeMessage language="Agent output">{transcript}</CodeMessage>
          ) : live ? (
            <LoadingState
              size="md"
              label="Warming up…"
              footnote="The agent is on it; its first output will appear here any moment."
            />
          ) : (
            <EmptyState
              icon={RadioTower}
              title="Nothing came through"
              body="This run produced no visible output before it settled."
            />
          )}
        </div>

        {/* The one steering control we can offer honestly today: stop the
            agent on this node. Wired to the same lane-cancel the orchestrator
            surface uses, so it kills the real brain session. */}
        {lane && live ? (
          <SheetFooter>
            <span>Streaming the agent's own output, live.</span>
            <StopLaneButton laneId={lane.lane_id} />
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
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
    <Button
      variant="outline"
      size="xs"
      onClick={stop}
      disabled={stopping}
      title="Stop this agent. Ends its session and frees the files it was editing"
    >
      {stopping ? <AsciiSpinner size={10} /> : null}
      {stopping ? "Stopping…" : "Stop this agent"}
    </Button>
  );
}
