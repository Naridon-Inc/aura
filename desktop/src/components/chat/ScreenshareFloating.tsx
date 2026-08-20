// Floating Picture-in-Picture screenshare preview — v0.2.24 (HH.13).
//
// When a screenshare is active but the ScreenshareTab workpane isn't
// the focused tab in any pane, this small draggable video lets the
// user keep an eye on the share without leaving whatever they're
// working on. Closes the gap where today you'd miss a live demo if
// you flipped over to a file tab.
//
// Behaviour:
//   • Visible only when:
//       - at least one screenshare track is published in the active
//         huddle, AND
//       - the ScreenshareTab workpane for this huddle is NOT the
//         currently-active tab in any pane (otherwise we'd double-render
//         the same video at two sizes).
//   • Draggable via pointer events. Position persists to
//     localStorage `aura.screenshare.pip.pos` and is clamped to the
//     viewport on mount + on window resize.
//   • "Pop out" button dispatches the same `aura:open-screenshare`
//     event the StatusBar pill / dock fire — App.tsx already listens
//     and routes it to `editor.openScreenshare(id)`. Once the tab
//     focuses, this PiP auto-hides (the visibility check sees the
//     active screenshare ref).
//   • Carries `data-incall-control="true"` so the HH.9 Esc-to-leave
//     keybinding works while the PiP is focused.
//
// Track attach is the standard LiveKit pattern — `track.attach(el)` /
// `track.detach(el)` against the singleton Track instance from
// callStore. Re-attaches when the track instance changes so swapping
// sharers swaps the visible <video>.

import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, X } from "lucide-react";
import {
  callScreenshareWorkpaneId,
  useCallSnapshot,
  type CallScreenshareTrack,
} from "../../lib/callStore";
import { treeLeafNodes, useEditorStore } from "../../lib/editorStore";

const POS_KEY = "aura.screenshare.pip.pos";
const PIP_WIDTH = 240;
const PIP_HEIGHT = 135;
const MARGIN = 16;

type Position = { x: number; y: number };

function readSavedPos(): Position | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Position;
    if (typeof parsed?.x !== "number" || typeof parsed?.y !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeSavedPos(pos: Position): void {
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* private mode / quota — fine, position resets on reload */
  }
}

function clampToViewport(pos: Position): Position {
  if (typeof window === "undefined") return pos;
  const maxX = Math.max(MARGIN, window.innerWidth - PIP_WIDTH - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - PIP_HEIGHT - MARGIN);
  return {
    x: Math.min(Math.max(MARGIN, pos.x), maxX),
    y: Math.min(Math.max(MARGIN, pos.y), maxY),
  };
}

function defaultPos(): Position {
  if (typeof window === "undefined") return { x: MARGIN, y: MARGIN };
  return {
    x: Math.max(MARGIN, window.innerWidth - PIP_WIDTH - MARGIN),
    y: Math.max(MARGIN, window.innerHeight - PIP_HEIGHT - MARGIN - 32),
  };
}

export function ScreenshareFloating() {
  const snap = useCallSnapshot();
  const editor = useEditorStore();

  // Pick the first remote share if available, otherwise the first
  // local share — we still want to show the PiP for the local
  // sharer's own confidence preview when their workpane isn't focused.
  // The full multi-sharer switcher lives in ScreenshareTab; PiP is
  // intentionally minimal.
  const track: CallScreenshareTrack | null = useMemo(() => {
    if (!snap.active || !snap.screenshareTracks.length) return null;
    const remote = snap.screenshareTracks.find((t) => !t.isLocal);
    return remote ?? snap.screenshareTracks[0] ?? null;
  }, [snap.active, snap.screenshareTracks]);

  // Hide when the screenshare workpane is the currently-active tab in
  // any visible pane — no point double-rendering the same MediaStream.
  // The tab can be open AS a tab but not active (background tab), in
  // which case the PiP is still useful.
  const tabIsActive = useMemo(() => {
    if (!snap.repoRoot || !snap.channel || !editor.splitLayout) return false;
    const targetId = callScreenshareWorkpaneId(snap.repoRoot, snap.channel);
    for (const leaf of treeLeafNodes(editor.splitLayout)) {
      const active = leaf.tabs[leaf.activeIndex];
      if (active && active.kind === "screenshare" && active.id === targetId) {
        return true;
      }
    }
    return false;
  }, [snap.repoRoot, snap.channel, editor.splitLayout]);

  const [pos, setPos] = useState<Position>(() =>
    clampToViewport(readSavedPos() ?? defaultPos()),
  );
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  // Re-clamp on window resize so the PiP doesn't end up off-screen if
  // the user resizes the window to be smaller than the saved position.
  useEffect(() => {
    const onResize = () => {
      setPos((p) => clampToViewport(p));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Skip drags initiated on interactive children (buttons) so the
    // close / pop-out clicks still work as clicks, not drag-starts.
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    e.preventDefault();
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const next = clampToViewport({
      x: e.clientX - drag.dx,
      y: e.clientY - drag.dy,
    });
    setPos(next);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    writeSavedPos(pos);
  }

  function popOut() {
    if (!snap.repoRoot || !snap.channel) return;
    window.dispatchEvent(
      new CustomEvent("aura:open-screenshare", {
        detail: {
          workpaneId: callScreenshareWorkpaneId(snap.repoRoot, snap.channel),
          repoRoot: snap.repoRoot,
          channel: snap.channel,
        },
      }),
    );
  }

  const [dismissedForTrackKey, setDismissedForTrackKey] = useState<
    string | null
  >(null);
  useEffect(() => {
    // Reset dismissal when the track changes or the call ends — a new
    // share should re-show the PiP even if the user hid the previous one.
    if (!track) {
      if (dismissedForTrackKey !== null) setDismissedForTrackKey(null);
    } else if (
      dismissedForTrackKey !== null &&
      dismissedForTrackKey !== track.key
    ) {
      setDismissedForTrackKey(null);
    }
  }, [track, dismissedForTrackKey]);

  if (!track || tabIsActive) return null;
  if (dismissedForTrackKey === track.key) return null;

  return (
    <div
      data-incall-control="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: PIP_WIDTH,
        height: PIP_HEIGHT,
        zIndex: 9999,
        cursor: dragRef.current ? "grabbing" : "grab",
        touchAction: "none",
      }}
      className="rounded-lg overflow-hidden bg-black shadow-2xl ring-1 ring-white/20"
    >
      <div className="absolute inset-x-0 top-0 h-6 flex items-center justify-between px-2 bg-black/70 backdrop-blur text-2xs text-white/90 select-none">
        <span className="truncate flex-1">
          {track.participantName}
          {track.isLocal ? " (you)" : ""}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={popOut}
            title="Open full screenshare tab"
            aria-label="Pop out screenshare"
            className="p-1 rounded hover:bg-white/15 transition"
          >
            <Maximize2 size={11} />
          </button>
          <button
            type="button"
            onClick={() => setDismissedForTrackKey(track.key)}
            title="Hide preview"
            aria-label="Hide preview"
            className="p-1 rounded hover:bg-white/15 transition"
          >
            <X size={11} />
          </button>
        </div>
      </div>
      <ScreenshareFloatingVideo trackKey={track.key} track={track.track} />
    </div>
  );
}

function ScreenshareFloatingVideo({
  trackKey,
  track,
}: {
  trackKey: string;
  track: {
    attach: (el: HTMLMediaElement) => void;
    detach: (el: HTMLMediaElement) => void;
  };
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      track.attach(el);
    } catch (e) {
      console.warn("ScreenshareFloating.attach failed", e);
    }
    return () => {
      try {
        track.detach(el);
      } catch (e) {
        console.warn("ScreenshareFloating.detach failed", e);
      }
    };
  }, [track, trackKey]);
  return (
    <video
      key={trackKey}
      ref={ref}
      autoPlay
      playsInline
      muted
      className="h-full w-full bg-black object-contain"
    />
  );
}
