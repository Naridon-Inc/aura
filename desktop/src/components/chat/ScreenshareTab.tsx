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
  Headphones,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  MonitorX,
  Send,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { monogram } from "../../lib/monogram";
import { clockTimeFromSecs } from "../../lib/clockTime";
import { api, type ChatMessage } from "../../lib/api";
import { parseAttachments } from "./FileAttachment";
import { Avatar } from "../team/presentation/Avatar";
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
    <div
      ref={rootRef}
      className="slack-huddle-stage relative flex h-full w-full flex-col overflow-hidden text-white"
      data-incall-control="true"
    >
      {/* Top bar */}
      <div className="slack-huddle-topbar flex h-10 shrink-0 items-center justify-center gap-1.5 px-4">
        <Headphones size={12} />
        <span>Huddle in <strong>#{channel}</strong></span>
        <button type="button" onClick={toggleFullscreen} className="slack-huddle-popout" aria-label={isFs ? "Exit fullscreen" : "Fullscreen"}>
          {isFs ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>

      <div className="slack-huddle-main flex flex-1 min-h-0 gap-1">
      {/* Stage body */}
      <div className="slack-huddle-video-stage flex flex-1 min-w-0 min-h-0 flex-col px-8 py-8">
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
              <div className="absolute right-3 top-3 flex h-6 items-center gap-1.5 rounded-md bg-black/55 px-2 text-xs font-bold tracking-wide backdrop-blur">
                <span className="h-1.5 w-1.5 rounded-full bg-red" />
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
                          "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition " +
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
                <Monitor size={13} className="text-[var(--color-accent-green)]" />
                {share.isLocal ? "You" : share.participantName} · screen
              </div>
              {share.isLocal && (
                <button
                  type="button"
                  onClick={toggleScreen}
                  className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-red px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur transition-opacity hover:opacity-90"
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

      {threadOpen && parsed && (
        <HuddleThread repoRoot={parsed.repoRoot} channel={parsed.channel} onClose={() => setThreadOpen(false)} />
      )}
      </div>

      {/* Full-width Slack huddle control bar */}
      {!ended && (
        <div className="slack-huddle-footer relative flex h-[70px] shrink-0 items-center justify-center gap-3 px-5">
          <div className="slack-huddle-meta">
            <Users size={16} /><span>{count}</span><i />
            <strong>{snap.channelName || `#${channel}`}</strong>
          </div>
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
          {/* Reactions and Huddle settings used to sit here, styled exactly
              like Mic and Camera beside them and wired to `() => {}`. There
              are no in-call reactions to send and no huddle settings to open,
              so the two buttons hovered, depressed and did nothing — and did
              it in the middle of the row of controls that work. */}
          <CtlButton
            onClick={() => leaveCall()}
            tone="hangup"
            title="Disconnect"
          >
            <span className="px-3 text-sm font-bold">Leave</span>
          </CtlButton>
          <button type="button" onClick={() => setThreadOpen((value) => !value)} className={`slack-huddle-thread-toggle ${threadOpen ? "is-active" : ""}`} aria-label="Toggle huddle thread">
            <MessageCircle size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

function HuddleThread({
  repoRoot,
  channel,
  onClose,
}: {
  repoRoot: string;
  channel: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    try {
      const rows = await api.chatList(repoRoot, channel, undefined, 60);
      setMessages(rows.filter((message) => !message.thread_parent));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  // Channel identity defines the lifetime of this huddle thread.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, channel]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const message = await api.chatSend({ repoRoot, channel, body });
      setMessages((rows) => [...rows, message]);
      setDraft("");
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="slack-huddle-thread">
      <header>
        <strong>Thread</strong>
        <span className="flex-1" />
        {/* No decorative glyph beside the close button: in a header's action
            row, anything icon-shaped reads as something you can press. */}
        <button type="button" onClick={onClose} aria-label="Close huddle thread">×</button>
      </header>
      <div ref={scrollerRef} className="slack-huddle-thread-messages">
        <div className="slack-huddle-thread-intro">
          <MessageCircle size={17} />
          <p><strong>Every huddle has a thread.</strong><br />What you send here reaches everyone in the huddle and is saved in <b>#{channel}</b>, so it’s still there after the huddle ends.</p>
        </div>
        {messages.slice(-18).map((message) => {
          const body = parseAttachments(message.body).text;
          return (
            <div key={message.id} className="slack-huddle-thread-message">
              <Avatar name={message.from_name || message.from_handle} size={34} />
              <div>
                <p><strong>{message.from_name || message.from_handle}</strong><time>{clockTimeFromSecs(message.ts)}</time></p>
                <span>{body || "Shared an attachment"}</span>
              </div>
            </div>
          );
        })}
      </div>
      {/* The red "B" square that used to lead this row is Slack's
          external-connection badge. It came across with the layout and means
          nothing here — a coloured mark that labels nothing is worse than no
          mark. The sentence is true, so the sentence stays. */}
      <div className="slack-huddle-external"><span>Huddle notes are shared with everyone in this channel</span></div>
      <div className="slack-huddle-reply">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Reply…"
          rows={2}
        />
        <div>
          {/* Attach, emoji, mention and formatting stood here with no onClick
              at all — four buttons that hovered like the send button and did
              nothing when pressed. None of the four has anything behind it:
              the huddle thread sends text. Whichever one gets something
              behind it comes back with it. */}
          <span className="flex-1" />
          <button type="button" onClick={() => void send()} disabled={!draft.trim() || sending} className="is-send"><Send size={16} /></button>
        </div>
        {error && <small title={error}>Couldn’t sync the huddle thread.</small>}
      </div>
    </aside>
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
  // One monogram for the whole app — see lib/monogram.
  const initial = monogram(p.name);
  return (
    <div
      className="slack-huddle-participant relative overflow-hidden border border-white/5"
      style={{
        aspectRatio: "16 / 10",
        background: p.cameraTrack ? "#0d0d11" : gradientFor(p.name),
        boxShadow: p.isSpeaking
          ? "inset 0 0 0 2px var(--color-accent-green)"
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
      <div className="absolute bottom-2 left-2 flex h-6 max-w-[calc(100%-16px)] items-center gap-1.5 rounded-lg bg-black/55 px-2 text-sm font-semibold backdrop-blur">
        {!p.micEnabled && <MicOff size={11} className="shrink-0 text-red" />}
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
      bg: "#ffffff",
      color: "var(--color-accent-green)",
    },
    danger: {
      bg: "color-mix(in srgb, var(--color-red) 20%, transparent)",
      color: "var(--color-red)",
    },
    hangup: { bg: "var(--color-red)", color: "#fff" },
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
          ? "Huddle ended. Close this tab to dismiss."
          : "Waiting for the call to connect…"}
      </div>
    </div>
  );
}

function StageConnecting() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-white/55">
      <AsciiSpinner />
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
