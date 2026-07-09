// Call stage — the full-area in-call surface for the active huddle.
// Mounted by WorkSurface when the layout carries a
// `{ kind: "screenshare", id }` ref (the id is the composite huddle key
// `<repoRoot>::<channel>`). The dock's "Open call view" button and the
// auto-open-on-share both route here.
//
// It renders three things over a dark stage:
//
//   1. A spotlight — the active screenshare (contain-fit <video>), with
//      a LIVE badge, the sharer's name pill, and a multi-sharer switch
//      when 2+ people share at once.
//   2. A participant grid / filmstrip — one tile per participant.
//      Camera-on participants render their webcam <video>; everyone else
//      gets an avatar-on-gradient fallback. The active speaker gets a
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

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  MonitorX,
  PhoneOff,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
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
    <div
      ref={rootRef}
      className="relative flex h-full w-full flex-col overflow-hidden bg-[#050507] text-white"
      data-incall-control="true"
    >
      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-12 items-center gap-2 bg-gradient-to-b from-black/55 to-transparent px-4">
        <span className="text-sm font-semibold text-white/90">
          <span className="text-white/40">#</span>
          {channel}
        </span>
        {!ended && (
          <span className="pointer-events-auto ml-2 flex h-7 items-center gap-1.5 rounded-lg bg-white/[0.08] px-2.5 text-[11.5px] text-white/80">
            <Users size={13} />
            {count} connected
          </span>
        )}
      </div>

      {/* Stage body */}
      <div className="flex flex-1 min-h-0 flex-col px-4 pb-24 pt-14">
        {ended ? (
          <StageEmpty ended />
        ) : share ? (
          <div className="flex h-full min-h-0 gap-3">
            {/* Spotlight */}
            <div className="relative flex min-w-0 flex-[3] overflow-hidden rounded-2xl border border-white/5 bg-black">
              <StageVideo
                trackKey={share.key}
                track={share.track}
                fit="contain"
              />
              <div className="absolute right-3 top-3 flex h-6 items-center gap-1.5 rounded-md bg-black/55 px-2 text-[10.5px] font-bold tracking-wide backdrop-blur">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                LIVE
              </div>
              {sharers.length >= 2 && (
                <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-1 rounded-lg bg-black/50 p-1 backdrop-blur">
                  {sharers.map((t) => {
                    const on = t.key === share.key;
                    return (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setActiveKey(t.key)}
                        className={
                          "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition " +
                          (on
                            ? "bg-white/20 text-white"
                            : "text-white/60 hover:bg-white/10 hover:text-white")
                        }
                        title={t.isLocal ? "Your screen" : t.participantName}
                      >
                        <Monitor size={11} />
                        <span className="max-w-[120px] truncate">
                          {t.isLocal ? "You" : t.participantName}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="absolute bottom-3 left-3 flex h-7 items-center gap-1.5 rounded-lg bg-black/60 px-2.5 text-xs font-semibold backdrop-blur">
                <Monitor size={13} className="text-[var(--color-accent-green,#4dc1a4)]" />
                {share.isLocal ? "You" : share.participantName} · screen
              </div>
              {share.isLocal && (
                <button
                  type="button"
                  onClick={toggleScreen}
                  className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-red-600/90 px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur transition hover:bg-red-600"
                  title="Stop sharing this screen"
                >
                  <MonitorX size={12} />
                  Stop sharing
                </button>
              )}
            </div>
            {/* Filmstrip */}
            <div className="flex w-[224px] shrink-0 flex-col gap-2 overflow-y-auto">
              {participants.map((p) => (
                <ParticipantTile key={p.sid} p={p} />
              ))}
            </div>
          </div>
        ) : count > 0 ? (
          <ParticipantGrid participants={participants} />
        ) : (
          <StageConnecting />
        )}
      </div>

      {/* Floating control bar */}
      {!ended && (
        <div className="absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-2xl border border-white/10 bg-[#16161a]/85 px-2.5 py-2 shadow-[0_14px_36px_-10px_rgba(0,0,0,0.7)] backdrop-blur">
          <CtlButton
            onClick={() => void setMicEnabledPreference(!snap.micEnabled)}
            tone={snap.micEnabled ? "default" : "danger"}
            title={snap.micEnabled ? "Mute" : "Unmute"}
          >
            {snap.micEnabled ? <Mic size={19} /> : <MicOff size={19} />}
          </CtlButton>
          <CtlButton
            onClick={() => void toggleCallCamera()}
            tone={snap.cameraEnabled ? "active" : "default"}
            title={snap.cameraEnabled ? "Turn off camera" : "Turn on camera"}
          >
            {snap.cameraEnabled ? <Video size={19} /> : <VideoOff size={19} />}
          </CtlButton>
          <CtlButton
            onClick={toggleScreen}
            tone={snap.screenshareEnabled ? "active" : "default"}
            title={snap.screenshareEnabled ? "Stop sharing" : "Share screen"}
          >
            <Monitor size={19} />
          </CtlButton>
          <span className="mx-1 h-7 w-px bg-white/10" />
          <CtlButton
            onClick={() => leaveCall()}
            tone="hangup"
            title="Disconnect"
          >
            <PhoneOff size={19} />
          </CtlButton>
        </div>
      )}

      {/* Fullscreen toggle */}
      {!ended && (
        <button
          type="button"
          onClick={toggleFullscreen}
          className="absolute bottom-7 right-5 z-10 flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.08] text-white/70 transition hover:bg-white/15 hover:text-white"
          title={isFs ? "Exit fullscreen" : "Fullscreen"}
          aria-label={isFs ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFs ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
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
    <div className="flex h-full min-h-0 items-center justify-center">
      <div
        className="grid w-full max-w-5xl gap-3"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}
      >
        {participants.map((p) => (
          <ParticipantTile key={p.sid} p={p} big />
        ))}
      </div>
    </div>
  );
}

function ParticipantTile({ p, big = false }: { p: CallParticipant; big?: boolean }) {
  const initial = (p.name.trim()[0] || "?").toUpperCase();
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-white/5"
      style={{
        aspectRatio: "16 / 10",
        background: p.cameraTrack ? "#0d0d11" : gradientFor(p.name),
        boxShadow: p.isSpeaking
          ? "inset 0 0 0 2px var(--color-accent-green,#4dc1a4)"
          : undefined,
      }}
    >
      {p.cameraTrack ? (
        <StageVideo
          trackKey={`${p.sid}:cam`}
          track={p.cameraTrack}
          fit="cover"
          mirror={p.isLocal}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="flex items-center justify-center rounded-full border-2 border-white/15 bg-black/25 font-bold text-white"
            style={{
              width: big ? 76 : 52,
              height: big ? 76 : 52,
              fontSize: big ? 30 : 20,
            }}
          >
            {initial}
          </div>
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex h-6 max-w-[calc(100%-16px)] items-center gap-1.5 rounded-lg bg-black/55 px-2 text-[11.5px] font-semibold backdrop-blur">
        {!p.micEnabled && <MicOff size={11} className="shrink-0 text-red-400" />}
        <span className="truncate">{p.isLocal ? `${p.name} (you)` : p.name}</span>
      </div>
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
      className="absolute inset-0 h-full w-full bg-black"
      style={{
        objectFit: fit,
        transform: mirror ? "scaleX(-1)" : undefined,
      }}
    />
  );
}

// ─── Control button ────────────────────────────────────────────────────

function CtlButton({
  onClick,
  tone,
  title,
  children,
}: {
  onClick: () => void;
  tone: "default" | "active" | "danger" | "hangup";
  title: string;
  children: React.ReactNode;
}) {
  const styles: Record<typeof tone, { bg: string; color: string }> = {
    default: { bg: "rgba(255,255,255,0.08)", color: "#fff" },
    active: {
      bg: "color-mix(in srgb, var(--color-accent-green,#4dc1a4) 22%, transparent)",
      color: "var(--color-accent-green,#4dc1a4)",
    },
    danger: {
      bg: "color-mix(in srgb, var(--color-red,#ef4444) 20%, transparent)",
      color: "var(--color-red,#ef4444)",
    },
    hangup: { bg: "var(--color-red,#ef4444)", color: "#fff" },
  };
  const s = styles[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      className="flex items-center justify-center rounded-xl transition hover:brightness-110"
      style={{
        width: tone === "hangup" ? 58 : 44,
        height: 44,
        background: s.bg,
        color: s.color,
      }}
    >
      {children}
    </button>
  );
}

// ─── Empty / connecting states ─────────────────────────────────────────

function StageEmpty({ ended }: { ended: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-white/60">
      <MonitorOff size={30} className="opacity-50" />
      <div>
        {ended
          ? "Huddle ended — close this tab to dismiss."
          : "Waiting for the call to connect…"}
      </div>
    </div>
  );
}

function StageConnecting() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-white/55">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
      <div>Connecting…</div>
    </div>
  );
}

// Deterministic two-stop gradient for the avatar-fallback tile, derived
// from the participant name so each person renders a stable colour.
function gradientFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(150deg, hsl(${hue} 46% 32%), hsl(${(hue + 26) % 360} 52% 20%))`;
}
