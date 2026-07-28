// VoiceDockPanel — compact "Voice Connected" bar that appears directly
// below the team-panel header ONLY while a huddle / call is active or
// connecting. When nothing is live it renders `null`, so the sidebar
// shows no voice chrome at all when idle (replaces the old always-
// visible bottom card + identity row).
//
// The bar reads exclusively from the callStore singleton, so it lives
// OUTSIDE <LiveKitRoom> — the LiveKit hooks for mic / screenshare state
// already run inside the CallPanel's HuddleUI (which still mounts but
// renders no visible UI). Anything that requires a live Room context is
// dispatched via the existing `aura:*` window events that CallPanel
// listens for. This keeps the bar simple: no hook ordering, no
// re-renders driven by SFU ticks.
//
// Layout (single ~40px row):
//   [signal] Voice Connected / #channel · repo   …   [mic][deafen]
//                                                     [share][board][end]
// Clicking the status block opens the full call stage (ScreenshareTab),
// which carries the heavier controls — camera, fullscreen, the
// participant grid. The bar is the quick-glance surface: connection
// state + the toggles you reach for mid-call.
//
// Mic + deafen live here (moved off the retired UserIdentityBar) so they
// PERSIST between calls via localStorage — a user who muted before
// joining stays muted at join. State is owned by callStore
// (`getMicEnabledPreference` / `setMicEnabledPreference` /
// `getDeafenedPreference` / `setDeafenedPreference`); while a call is
// live the LiveKit participant is the source of truth for the mic and we
// reflect `snap.micEnabled` into the visible toggle.
//
// Cross-repo scoping (JJ.3, #328): when the caller is a per-repo surface
// (CommsPanel mounted for repo R), it passes `currentRepoRoot` and we
// only render when the active huddle belongs to that repo. Pass `null`
// (or omit) to render unconditionally — used by global surfaces.
//
// Soundboard stays a real popover (a menu of clips is a legitimate
// popup) and opens DOWNWARD now that the bar sits at the top of the
// panel. Screenshare is tri-state: stop my share / view their share /
// start sharing.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Headphones,
  HeadphoneOff,
  Maximize2,
  Mic,
  MicOff,
  Monitor,
  PhoneOff,
  Rss,
  Smile,
  Trash2,
  Upload,
} from "lucide-react";
import {
  callScreenshareWorkpaneId,
  getDeafenedPreference,
  getMicEnabledPreference,
  leaveCall,
  liveCallLocalParticipant,
  setDeafenedPreference,
  setMicEnabledPreference,
  useCallSnapshot,
} from "../../lib/callStore";
import {
  deleteSoundboardClip,
  listSoundboardClips,
  listSoundboardSeeds,
  playSoundboardClip,
  playSoundboardSeed,
  uploadSoundboardClip,
  type SoundboardSeed,
} from "../../lib/soundboard";
import type { SoundboardClip } from "../../lib/api";

export function VoiceDockPanel({
  currentRepoRoot = null,
}: {
  /** Render the bar only when the live huddle belongs to this repo
   *  root. `null` disables the guard (global mount points). */
  currentRepoRoot?: string | null;
} = {}) {
  const snap = useCallSnapshot();

  // Persisted mic / deafen preferences (own them here now that the
  // identity bar is retired). While a call is live, mirror the real
  // publishing state from the snapshot.
  const [micEnabled, setMicEnabled] = useState<boolean>(() =>
    getMicEnabledPreference(),
  );
  const [deafened, setDeafened] = useState<boolean>(() =>
    getDeafenedPreference(),
  );
  useEffect(() => {
    if (snap.active) setMicEnabled(snap.micEnabled);
  }, [snap.active, snap.micEnabled]);

  // Apply the persistent deafen state to LiveKit's <RoomAudioRenderer>
  // audio elements. The interval re-applies so late-joining remotes are
  // also muted.
  useEffect(() => {
    if (!snap.active) return;
    const apply = () => {
      const muted = getDeafenedPreference();
      const audios = document.querySelectorAll<HTMLAudioElement>(
        "audio[data-lk-source], audio[data-lk-track-source]",
      );
      audios.forEach((el) => {
        el.muted = muted;
      });
    };
    apply();
    const id = window.setInterval(apply, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [snap.active]);

  // Soundboard popover.
  const [boardOpen, setBoardOpen] = useState(false);
  const boardAnchorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!boardOpen) return;
    const onDown = (ev: MouseEvent) => {
      const node = boardAnchorRef.current;
      if (!node) return;
      if (ev.target instanceof Node && node.contains(ev.target)) return;
      setBoardOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [boardOpen]);

  if (!snap.active && !snap.connecting) return null;
  // Repo-scope guard: hide when the caller is a per-repo surface and the
  // live huddle was started from a different repo. `connecting`
  // snapshots may not have stamped `repoRoot` yet, so only enforce once
  // active.
  if (
    currentRepoRoot &&
    snap.active &&
    snap.repoRoot &&
    snap.repoRoot !== currentRepoRoot
  ) {
    return null;
  }

  const channelLabel = snap.channel
    ? `#${snap.channelName ?? snap.channel}`
    : "Huddle";
  const repoLabel = snap.repoRoot ? shortRepoName(snap.repoRoot) : "";
  const connecting = snap.connecting && !snap.active;
  const accent = connecting
    ? "var(--color-amber)"
    : "var(--color-accent-green)";

  function openCallStage() {
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

  function toggleScreenshare() {
    // HuddleUI listens for "aura:toggle-screenshare" and flips
    // `localParticipant.setScreenShareEnabled`.
    if (!snap.repoRoot || !snap.channel) return;
    window.dispatchEvent(
      new CustomEvent("aura:toggle-screenshare", {
        detail: { repoRoot: snap.repoRoot, channel: snap.channel },
      }),
    );
  }

  // Tri-state screenshare:
  //   • Local user sharing   → stop sharing
  //   • Remote user sharing  → open the call stage to view it
  //   • Nobody sharing       → start sharing
  const localSharing = snap.screenshareEnabled;
  const remoteSharing = snap.screenshareTracks.some((t) => !t.isLocal);
  function onScreenshareClick() {
    if (localSharing) toggleScreenshare();
    else if (remoteSharing) openCallStage();
    else toggleScreenshare();
  }

  async function onToggleMic() {
    const next = !micEnabled;
    setMicEnabled(next);
    try {
      await setMicEnabledPreference(next);
    } catch (e) {
      console.warn("VoiceDockPanel: toggle mic failed", e);
    }
  }

  function onToggleDeafen() {
    const next = !deafened;
    setDeafened(next);
    setDeafenedPreference(next);
  }

  return (
    <div
      className="mx-2 my-1 flex shrink-0 items-center gap-1 rounded-lg py-1 pl-2 pr-1"
      style={{
        background: "color-mix(in srgb, var(--color-bg-1) 60%, transparent)",
        borderLeft: `2px solid ${accent}`,
        minHeight: 40,
      }}
      role="region"
      aria-label="Voice connection"
      data-incall-control="true"
    >
      {/* Status — click opens the full call stage. */}
      <button
        type="button"
        onClick={openCallStage}
        className="flex min-w-0 flex-1 items-center gap-2 text-left transition-opacity hover:opacity-90"
        title={`Open call view — ${channelLabel}${repoLabel ? ` / ${repoLabel}` : ""}`}
      >
        <span
          className={`flex shrink-0 ${connecting ? "animate-pulse" : ""}`}
          style={{ color: accent }}
          aria-hidden
        >
          <Rss size={15} />
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span
            className="truncate text-[11.5px] font-semibold"
            style={{ color: accent }}
          >
            {connecting ? "Connecting…" : "Voice Connected"}
          </span>
          <span
            className="block truncate text-[10px]"
            style={{ color: "var(--color-text-3)" }}
          >
            <span style={{ color: "var(--color-text-2)" }}>{channelLabel}</span>
            {repoLabel && (
              <>
                <span className="px-1 opacity-60">·</span>
                <span>{repoLabel}</span>
              </>
            )}
          </span>
        </span>
        <span
          className="ml-0.5 hidden shrink-0 text-text-4 group-hover:text-text-2 sm:flex"
          aria-hidden
        >
          <Maximize2 size={12} />
        </span>
      </button>

      {/* Control cluster — mic · deafen · screenshare · soundboard · end. */}
      <div className="flex shrink-0 items-center gap-0.5">
        <BarBtn
          onClick={onToggleMic}
          title={micEnabled ? "Mute microphone" : "Unmute microphone"}
          ariaLabel={micEnabled ? "Mute microphone" : "Unmute microphone"}
          tone={micEnabled ? "default" : "danger"}
        >
          {micEnabled ? <Mic size={14} /> : <MicOff size={14} />}
        </BarBtn>

        <BarBtn
          onClick={onToggleDeafen}
          title={deafened ? "Undeafen" : "Deafen"}
          ariaLabel={deafened ? "Undeafen" : "Deafen"}
          tone={deafened ? "danger" : "default"}
        >
          {deafened ? <HeadphoneOff size={14} /> : <Headphones size={14} />}
        </BarBtn>

        <BarBtn
          onClick={onScreenshareClick}
          on={localSharing || remoteSharing}
          title={
            localSharing
              ? "Stop sharing your screen"
              : remoteSharing
                ? "View shared screen"
                : "Share screen"
          }
          ariaLabel="Screen share"
        >
          <Monitor size={14} />
        </BarBtn>

        <div ref={boardAnchorRef} className="relative flex">
          <BarBtn
            onClick={() => setBoardOpen((v) => !v)}
            on={boardOpen}
            title="Soundboard"
            ariaLabel="Soundboard"
          >
            <Smile size={14} />
          </BarBtn>
          {boardOpen && (
            <SoundboardPopover
              repoRoot={snap.repoRoot}
              onClose={() => setBoardOpen(false)}
            />
          )}
        </div>

        <BarBtn
          onClick={() => leaveCall()}
          title="Disconnect"
          ariaLabel="Disconnect from voice"
          tone="danger"
        >
          <PhoneOff size={14} />
        </BarBtn>
      </div>
    </div>
  );
}

// ─── Soundboard popover ────────────────────────────────────────────

function SoundboardPopover({
  repoRoot,
  onClose,
}: {
  repoRoot: string | null;
  onClose: () => void;
}) {
  const seeds = useMemo<SoundboardSeed[]>(() => listSoundboardSeeds(), []);
  const [userClips, setUserClips] = useState<SoundboardClip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load user-uploaded clips on mount + after each upload/delete.
  const refresh = async () => {
    if (!repoRoot) {
      setUserClips([]);
      return;
    }
    try {
      const clips = await listSoundboardClips(repoRoot);
      setUserClips(clips);
    } catch (e) {
      console.warn("soundboard list failed", e);
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot]);

  const playSeed = async (seedId: string) => {
    setError(null);
    setPlaying(seedId);
    try {
      await playSoundboardSeed(seedId, liveCallLocalParticipant());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlaying(null);
    }
  };

  const playClip = async (clipId: string) => {
    if (!repoRoot) return;
    setError(null);
    setPlaying(clipId);
    try {
      await playSoundboardClip(repoRoot, clipId, liveCallLocalParticipant());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlaying(null);
    }
  };

  const onPickFile = () => {
    fileInputRef.current?.click();
  };
  const onFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    if (!repoRoot) {
      setError("No active repo");
      return;
    }
    setError(null);
    try {
      await uploadSoundboardClip(repoRoot, file);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (ev.target) ev.target.value = "";
    }
  };

  const onDelete = async (clipId: string) => {
    if (!repoRoot) return;
    try {
      await deleteSoundboardClip(repoRoot, clipId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Hotkeys 1..9 trigger the first 9 clips (seeds first, then user
  // clips). Active while the popover is open.
  const allPlayable = useMemo(
    () =>
      [
        ...seeds.map((s) => ({ kind: "seed" as const, id: s.id })),
        ...userClips.map((c) => ({ kind: "clip" as const, id: c.id })),
      ].slice(0, 9),
    [seeds, userClips],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const item = allPlayable[n - 1];
      if (!item) return;
      e.preventDefault();
      if (item.kind === "seed") void playSeed(item.id);
      else void playClip(item.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allPlayable, repoRoot]);

  void onClose;

  return (
    <div
      role="dialog"
      aria-label="Soundboard"
      className="absolute top-full mt-1 right-0 flex w-[280px] flex-col rounded-md border shadow-lg"
      style={{
        background: "var(--color-bg-1)",
        borderColor: "var(--color-line-soft)",
        zIndex: 50,
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5"
        style={{ color: "var(--color-text-3)" }}
      >
        <span className="text-[10.5px] font-semibold uppercase tracking-wider">
          Soundboard
        </span>
        <button
          type="button"
          onClick={onPickFile}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] hover:bg-bg-2"
          title="Upload an audio clip"
        >
          <Upload size={11} />
          Upload
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp3,.wav,.ogg,.m4a,audio/mpeg,audio/wav,audio/ogg,audio/mp4"
          className="hidden"
          onChange={onFile}
        />
      </div>
      <div
        className="flex max-h-[260px] flex-col overflow-y-auto"
        style={{ borderTop: "1px solid var(--color-line-soft)" }}
      >
        {seeds.map((s, i) => (
          <SoundboardRow
            key={s.id}
            label={s.name}
            emoji={s.emoji}
            hotkey={i + 1 <= 9 ? i + 1 : undefined}
            playing={playing === s.id}
            onPlay={() => playSeed(s.id)}
          />
        ))}
        {userClips.length === 0 ? (
          <div
            className="px-3 py-3 text-center text-[10.5px]"
            style={{ color: "var(--color-text-4)" }}
          >
            Upload short mp3 / wav clips (≤2 MB) for your team.
          </div>
        ) : (
          userClips.map((c, i) => {
            const hotIdx = seeds.length + i + 1;
            return (
              <SoundboardRow
                key={c.id}
                label={c.name}
                emoji="🎵"
                hotkey={hotIdx <= 9 ? hotIdx : undefined}
                playing={playing === c.id}
                onPlay={() => playClip(c.id)}
                onDelete={() => onDelete(c.id)}
              />
            );
          })
        )}
      </div>
      {error && (
        <div
          className="px-3 py-1.5 text-[10.5px]"
          style={{
            background: "color-mix(in srgb, var(--color-red) 12%, transparent)",
            color: "var(--color-red)",
            borderTop: "1px solid var(--color-line-soft)",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function SoundboardRow({
  label,
  emoji,
  hotkey,
  playing,
  onPlay,
  onDelete,
}: {
  label: string;
  emoji: string;
  hotkey?: number;
  playing: boolean;
  onPlay: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 hover:bg-bg-2"
      style={{ color: "var(--color-text-2)" }}
    >
      <button
        type="button"
        onClick={onPlay}
        className="flex flex-1 items-center gap-2 text-left text-[11.5px]"
        disabled={playing}
      >
        <span className="text-[14px]" aria-hidden>
          {emoji}
        </span>
        <span className="flex-1 truncate" style={{ color: "var(--color-text-1)" }}>
          {label}
        </span>
        {playing && (
          <span
            className="text-[10px]"
            style={{ color: "var(--color-accent-green)" }}
          >
            playing…
          </span>
        )}
        {hotkey !== undefined && (
          <kbd
            className="rounded px-1 py-0.5 text-[9.5px] tabular-nums"
            style={{
              background: "var(--color-bg-2)",
              color: "var(--color-text-3)",
              border: "1px solid var(--color-line-soft)",
            }}
          >
            {hotkey}
          </kbd>
        )}
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="flex h-5 w-5 items-center justify-center rounded text-[10px] opacity-50 hover:bg-bg-2 hover:opacity-100"
          title="Delete clip"
          aria-label="Delete clip"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}

// ─── Compact bar icon button ───────────────────────────────────────

function BarBtn({
  onClick,
  title,
  ariaLabel,
  children,
  tone = "default",
  on = false,
}: {
  onClick: () => void;
  title: string;
  ariaLabel: string;
  children: React.ReactNode;
  tone?: "default" | "danger";
  /** Green "active" tint (e.g. screenshare live, popover open). */
  on?: boolean;
}) {
  const danger = tone === "danger";
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      title={title}
      aria-label={ariaLabel}
      className={
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors " +
        (danger
          ? "text-[var(--color-red)] hover:bg-[color-mix(in_srgb,var(--color-red)_16%,transparent)]"
          : on
            ? ""
            : "text-text-3 hover:bg-bg-3 hover:text-text-1")
      }
      style={
        on && !danger
          ? {
              background:
                "color-mix(in srgb, var(--color-accent-green) 16%, transparent)",
              color: "var(--color-accent-green)",
            }
          : undefined
      }
    >
      {children}
    </button>
  );
}

// Pretty-print the repo root for the secondary context line. Trims to
// the last path segment so the bar stays compact at narrow widths.
function shortRepoName(repoRoot: string): string {
  const trimmed = repoRoot.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1) return trimmed;
  return trimmed.slice(idx + 1) || trimmed;
}
