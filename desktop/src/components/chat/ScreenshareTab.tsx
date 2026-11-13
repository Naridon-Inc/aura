// Call stage — the full-area in-call surface for the active huddle.
// Mounted by WorkSurface when the layout carries a
// `{ kind: "screenshare", id }` ref (the id is the composite huddle key
// `<repoRoot>::<channel>`). The dock's "Open call view" button and the
// auto-open-on-share both route here.
//
// It renders three things on the stage (the library's buttons, chips,
// states and segmented switch — see ui/call-stage.css):
//
//   1. A spotlight — the active screenshare (contain-fit <video>), with
//      a LIVE badge, the sharer's name pill, and a multi-sharer switch
//      when 2+ people share at once.
//   2. A participant grid / filmstrip — one tile per participant.
//      Camera-on participants render their webcam <video>; everyone else
//      gets their face. The active speaker gets a
//      green ring; muted participants show a red mic-off glyph.
//   3. A floating control bar — Mic · Camera · Screenshare · Disconnect,
//      plus a fullscreen toggle, all wired to the callStore imperative
//      helpers (the stage lives OUTSIDE <LiveKitRoom>, same as the dock).
//
// ## How it gets its data
//
// Like the dock, the stage reads the callStore singletons rather than
// LiveKit hooks: `useCallSnapshot()` for screenshare tracks + local
// toggle state, and `useCallParticipants()` for the roster (published by
// CallPanel's HuddleUI from inside the Room context). Track attach goes
// straight against the Track instance — the documented LiveKit API, the
// same path <ParticipantTile> takes.
//
// ## When the tab opens / closes
//
// Open: CallPanel auto-fires `aura:open-screenshare` the first time a
// new share appears; the dock's expand button fires it on demand.
// Close: the tab survives with an empty/ended state so it can be pinned
// and re-shared into without spawning a fresh tab.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Headphones,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  MonitorX,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import { Avatar } from "../team/presentation/Avatar";
import { Button } from "../ui/button";
import { SegmentedControl } from "../ui/segmented";
import { EmptyState, LoadingState } from "../ui/state";
import { StatusChip } from "../ui/statusChip";
import { HuddleThread } from "./HuddleThread";
import {
  leaveCall,
  parseScreenshareWorkpaneId,
  setMicEnabledPreference,
  toggleCallCamera,
  useCallParticipants,
  useCallSnapshot,
  type CallParticipant,
  type CallScreenshareTrack,
} from "../../lib/callStore";
import "../ui/call-stage.css";

type Props = {
  /** Workpane id — `<repoRoot>::<channel>`. */
  huddleKey: string;
};

/** Minimal structural view of a LiveKit Track — enough to attach/detach
 *  without importing the class (keeps this module free of livekit-client). */
type Attachable = {
  attach: (el: HTMLMediaElement) => void;
  detach: (el: HTMLMediaElement) => void;
};

export function ScreenshareTab({ huddleKey }: Props) {
  const snap = useCallSnapshot();
  const participants = useCallParticipants();
  const parsed = parseScreenshareWorkpaneId(huddleKey);

  // The tab is keyed to a specific huddle. If the user is no longer in
  // THAT huddle, show an "ended" state instead of stale media.
  const matchesActive =
    parsed !== null &&
    snap.repoRoot === parsed.repoRoot &&
    snap.channel === parsed.channel;

  // Screenshare tracks: local share pinned leftmost, then remotes.
  const sharers = useMemo<CallScreenshareTrack[]>(() => {
    if (!matchesActive) return [];
    const local = snap.screenshareTracks.filter((t) => t.isLocal);
    const remote = snap.screenshareTracks.filter((t) => !t.isLocal);
    return [...local, ...remote];
  }, [matchesActive, snap.screenshareTracks]);

  // User-selected spotlight share; falls back to first available.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  useEffect(() => {
    if (!sharers.length) {
      if (activeKey !== null) setActiveKey(null);
      return;
    }
    if (!activeKey || !sharers.some((t) => t.key === activeKey)) {
      setActiveKey(sharers[0].key);
    }
  }, [sharers, activeKey]);
  const share = sharers.find((t) => t.key === activeKey) ?? sharers[0] ?? null;

  // Fullscreen — request on the stage root, mirror the browser state.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isFs, setIsFs] = useState(false);
  const [threadOpen, setThreadOpen] = useState(true);
  useEffect(() => {
    const onFs = () => setIsFs(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFullscreen = () => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const toggleScreen = () => {
    if (!parsed) return;
    window.dispatchEvent(
      new CustomEvent("aura:toggle-screenshare", {
        detail: { repoRoot: parsed.repoRoot, channel: parsed.channel },
      }),
    );
  };

  const channel = parsed?.channel ?? "";
  const count = participants.length;
  const ended = !matchesActive;

  return (
    <div ref={rootRef} className="ui-call-stage" data-incall-control="true">
      <header className="ui-call-stage-header">
        <Headphones size={12} aria-hidden />
        <span>
          Huddle in <strong>#{channel}</strong>
        </span>
        <Button
          variant="ghost"
          size="iconXs"
          className="ui-call-stage-fullscreen"
          onClick={toggleFullscreen}
          aria-label={isFs ? "Exit fullscreen" : "Fullscreen"}
          title={isFs ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFs ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </Button>
      </header>

      <div className="ui-call-stage-main">
        <div className="ui-call-stage-body">
          {ended ? (
            <EmptyState icon={MonitorOff} title="Huddle ended." body="Close this tab to dismiss." />
          ) : share ? (
            <div className="ui-call-share">
              <div className="ui-call-spotlight">
                <StageVideo trackKey={share.key} track={share.track} fit="contain" />
                <span className="ui-call-stage-live">
                  <StatusChip tone="red" dot>
                    LIVE
                  </StatusChip>
                </span>
                {sharers.length >= 2 && (
                  <SegmentedControl
                    className="ui-call-sharers"
                    ariaLabel="Whose screen to watch"
                    value={share.key}
                    onChange={setActiveKey}
                    options={sharers.map((t) => ({
                      value: t.key,
                      label: (
                        <span className="ui-call-sharer" title={t.isLocal ? "Your screen" : t.participantName}>
                          <Monitor size={11} aria-hidden />
                          {t.isLocal ? "You" : t.participantName}
                        </span>
                      ),
                    }))}
                  />
                )}
                <span className="ui-call-pill ui-call-sharer-name">
                  <Monitor size={13} aria-hidden />
                  {share.isLocal ? "You" : share.participantName} · screen
                </span>
                {share.isLocal && (
                  <Button
                    variant="destructive"
                    size="xs"
                    className="ui-call-stop"
                    onClick={toggleScreen}
                    title="Stop sharing this screen"
                  >
                    <MonitorX size={12} aria-hidden />
                    Stop sharing
                  </Button>
                )}
              </div>
              <div className="ui-call-filmstrip">
                {participants.map((p) => (
                  <ParticipantTile key={p.sid} p={p} />
                ))}
              </div>
            </div>
          ) : count > 0 ? (
            <ParticipantGrid participants={participants} />
          ) : (
            <LoadingState size="md" label="Connecting…" />
          )}
        </div>

        {threadOpen && parsed && (
          <HuddleThread repoRoot={parsed.repoRoot} channel={parsed.channel} onClose={() => setThreadOpen(false)} />
        )}
      </div>

      {!ended && (
        <footer className="ui-call-controls">
          <span className="ui-call-meta">
            <Users size={14} aria-hidden />
            <span>{count}</span>
            <i aria-hidden />
            <strong>{snap.channelName || `#${channel}`}</strong>
          </span>
          <CtlButton
            onClick={() => void setMicEnabledPreference(!snap.micEnabled)}
            muted={!snap.micEnabled}
            title={snap.micEnabled ? "Mute" : "Unmute"}
          >
            {snap.micEnabled ? <Mic size={16} /> : <MicOff size={16} />}
          </CtlButton>
          <CtlButton
            onClick={() => void toggleCallCamera()}
            on={snap.cameraEnabled}
            title={snap.cameraEnabled ? "Turn off camera" : "Turn on camera"}
          >
            {snap.cameraEnabled ? <Video size={16} /> : <VideoOff size={16} />}
          </CtlButton>
          <CtlButton
            onClick={toggleScreen}
            on={snap.screenshareEnabled}
            title={snap.screenshareEnabled ? "Stop sharing" : "Share screen"}
          >
            <Monitor size={16} />
          </CtlButton>
          {/* Reactions and Huddle settings used to sit here, styled exactly
              like Mic and Camera beside them and wired to `() => {}`. There
              are no in-call reactions to send and no huddle settings to open,
              so the two buttons hovered, depressed and did nothing — and did
              it in the middle of the row of controls that work. */}
          <Button
            variant="destructive"
            onClick={() => leaveCall()}
            onMouseDown={(e) => e.preventDefault()}
            title="Disconnect"
            aria-label="Disconnect"
          >
            Leave
          </Button>
          <Button
            variant={threadOpen ? "secondary" : "ghost"}
            size="icon"
            className="ui-call-thread-toggle"
            onClick={() => setThreadOpen((value) => !value)}
            aria-label="Toggle huddle thread"
            aria-pressed={threadOpen}
            title={threadOpen ? "Hide thread" : "Show thread"}
          >
            <MessageCircle size={16} />
          </Button>
        </footer>
      )}
    </div>
  );
}

// ─── Participant grid (no active screenshare) ──────────────────────────

function ParticipantGrid({
  participants,
}: {
  participants: CallParticipant[];
}) {
  const n = participants.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  return (
    <div className="ui-call-grid-wrap">
      <div className="ui-call-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
        {participants.map((p) => (
          <ParticipantTile key={p.sid} p={p} big />
        ))}
      </div>
    </div>
  );
}

function ParticipantTile({ p, big = false }: { p: CallParticipant; big?: boolean }) {
  return (
    <div
      className="ui-call-tile"
      data-speaking={p.isSpeaking ? "" : undefined}
      data-camera={p.cameraTrack ? "" : undefined}
    >
      {p.cameraTrack ? (
        <StageVideo trackKey={`${p.sid}:cam`} track={p.cameraTrack} fit="cover" mirror={p.isLocal} />
      ) : (
        <span className="ui-call-tile-face">
          <Avatar name={p.name} size={big ? 76 : 52} />
        </span>
      )}
      <span className="ui-call-pill ui-call-tile-name">
        {!p.micEnabled && <MicOff size={11} className="ui-call-muted" aria-label="Muted" />}
        <span>{p.isLocal ? `${p.name} (you)` : p.name}</span>
      </span>
    </div>
  );
}

// ─── Shared video element (screenshare + camera) ───────────────────────

function StageVideo({
  trackKey,
  track,
  fit = "contain",
  mirror = false,
}: {
  trackKey: string;
  track: Attachable;
  fit?: "contain" | "cover";
  mirror?: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      track.attach(el);
    } catch (e) {
      console.warn("CallStage.attach failed", e);
    }
    return () => {
      try {
        track.detach(el);
      } catch (e) {
        console.warn("CallStage.detach failed", e);
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
      className="ui-call-video"
      style={{
        objectFit: fit,
        transform: mirror ? "scaleX(-1)" : undefined,
      }}
    />
  );
}

// ─── Control button ────────────────────────────────────────────────────

/** One in-call toggle: the library's icon button, filled while the thing it
 *  controls is on, red-glyphed while the mic is muted. It keeps focus where
 *  it was so a press never pulls the caret out of the thread. */
function CtlButton({
  onClick,
  on = false,
  muted = false,
  title,
  children,
}: {
  onClick: () => void;
  on?: boolean;
  muted?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <Button
      variant={on ? "default" : "secondary"}
      size="icon"
      className="ui-call-control"
      data-muted={muted ? "" : undefined}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      title={title}
      aria-label={title}
    >
      {children}
    </Button>
  );
}
