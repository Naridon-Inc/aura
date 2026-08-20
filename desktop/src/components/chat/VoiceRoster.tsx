// VoiceRoster — inline strip of teammates currently in the channel's
// voice room. Sits in the channel header (between the title and the
// header icon-buttons) so users see "who's in voice right now" without
// having to expand the call panel.
//
// Data source is the presence-beacon `voice_channel` field that already
// rides every announce — no extra polling, no LiveKit API call. The
// upstream caller (CommsPanel) filters `manifest.members` down to those
// whose `voice_channel` matches the active channel slug.
//
// Speaking-indicator: only shown for the local LiveKit participants
// (which we don't have access to here). We deliberately leave the
// indicator off in the roster — the floating CallPanel already shows
// per-participant `isSpeaking`. The roster is the "who" view; the call
// panel is the "what's happening" view.

import { Headphones, Mic } from "lucide-react";
import type { TeamMember } from "../../lib/api";
import { monogram } from "../../lib/monogram";

type VoiceRosterProps = {
  members: TeamMember[];
  /** If set, the local user is in this channel's voice room — the
   * roster renders a distinct "Leave" button instead of the (default)
   * "Join voice" button rendered by the parent. */
  inThisChannel: boolean;
  onJoin: () => void;
  onLeave: () => void;
};

export function VoiceRoster({
  members,
  inThisChannel,
  onJoin,
  onLeave,
}: VoiceRosterProps) {
  const n = members.length;

  if (n === 0 && !inThisChannel) {
    // No one's in voice and we're not either — render the join button
    // alone, no roster strip. Keeps the header lean when the channel
    // has no live call.
    return (
      <button
        type="button"
        onClick={onJoin}
        title="Join voice room"
        className="flex items-center gap-1 rounded-md border border-line-soft px-2 py-1 text-xs font-medium text-text-3 hover:bg-state-hover hover:text-text-1"
      >
        <Headphones size={11} />
        <span>Join voice</span>
      </button>
    );
  }

  // Showing avatars: up to 4 inline, then "+K" for the overflow. Most
  // calls have 2–4 people so the overflow is rare; capping at 4 keeps
  // the header height stable.
  const visible = members.slice(0, 4);
  const overflow = Math.max(0, n - visible.length);

  return (
    <div className="flex items-center gap-1.5">
      <div
        className="flex items-center gap-1 rounded-md border border-line-soft bg-bg-2 px-1.5 py-1"
        title={
          n === 0
            ? "You're in this voice room"
            : `${n} in voice: ${members.map((m) => m.name || m.handle).join(", ")}`
        }
      >
        <Mic size={10} className="text-accent-green" />
        <div className="flex -space-x-1">
          {visible.map((m) => (
            <span
              key={m.handle}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-bg-content text-2xs font-medium"
              style={{ background: tintForName(m.name || m.handle) }}
              aria-label={m.name || m.handle}
            >
              {initials(m.name || m.handle)}
            </span>
          ))}
          {overflow > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-bg-content bg-bg-3 px-1 text-2xs font-medium text-text-2">
              +{overflow}
            </span>
          )}
        </div>
        {n > 0 && (
          <span className="text-2xs tabular-nums text-text-3">{n}</span>
        )}
      </div>
      {inThisChannel ? (
        <button
          type="button"
          onClick={onLeave}
          title="Leave voice room"
          className="rounded-md border border-red/40 bg-red/10 px-2 py-1 text-xs font-medium text-red transition-colors hover:bg-red/20"
        >
          Leave
        </button>
      ) : (
        <button
          type="button"
          onClick={onJoin}
          title="Join voice room"
          className="flex items-center gap-1 rounded-md border border-line-soft bg-accent-green/10 px-2 py-1 text-xs font-medium text-accent-green transition-colors hover:bg-accent-green/15"
        >
          <Headphones size={11} />
          <span>Join</span>
        </button>
      )}
    </div>
  );
}

// Tiny inline chip for the channel-list rail. `🎧 N` only when N > 0;
// caller is expected to suppress the chip otherwise. Kept here so the
// chat-list and channel-header surfaces converge on the same visual
// language for "voice happening".
export function VoiceCountChip({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="ml-1 inline-flex items-center gap-0.5 rounded bg-accent-green/15 px-1 py-0 text-2xs font-semibold tabular-nums text-accent-green"
      title={`${count} in voice`}
      aria-label={`${count} in voice`}
    >
      <Headphones size={9} />
      {count}
    </span>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

function initials(name: string): string {
  // One monogram for the whole app — see lib/monogram.
  return monogram(name);
}

// Stable color picker keyed off the name — same hash family the rest of
// the chat uses for DM avatars. Inline-duplicated here (rather than
// imported) because the only other caller, CommsPanel, has its own copy
// and the function is six lines.
function tintForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 60%, 35%)`;
}
