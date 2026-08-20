// One avatar for either kind of thing in a session.
//
// Humans get the app's existing deterministic disc (`team/presentation/Avatar`)
// so the same person reads identically here, in chat, and in message bubbles —
// a second avatar system in the sidebar would mean the same teammate wearing
// two faces two panels apart. Agents get the app's existing brand mark
// (`agent/AgentIcon`), which resolves the real Claude / Gemini / Codex logo and
// falls back to a monogram tile for an agent we don't have a mark for.
//
// Nothing here re-implements either one. The only thing this file adds is the
// presence dot on top, and a size that goes down to pip scale — the existing
// avatars are built for 24–30px rows and the pips under a live session are 14.

import { Avatar } from "../../team/presentation/Avatar";
import { AgentIcon } from "../../agent/AgentIcon";
import { PresenceDot } from "./PresenceDot";
import { isPresent, presenceTitle, type RailActor } from "./railModel";

export type RailAvatarProps = {
  actor: RailActor;
  /** Diameter in px. 22 on a person's header row, 16 on a session row's last
   *  mover, 14 in a pip cluster. */
  size?: number;
  /** Draw the presence dot. Off for the trailing "who moved last" avatar,
   *  where the question is who, not whether they're still here. */
  showPresence?: boolean;
  /** The surface the presence ring is punched out of. */
  ring?: string;
  /** Overrides the hover text. Defaults to name + what they're doing. */
  title?: string;
};

/** Dot diameter that stays legible without swallowing the avatar. */
function dotSize(size: number): number {
  return Math.max(5, Math.round(size * 0.32));
}

export function RailAvatar({
  actor,
  size = 22,
  showPresence = false,
  ring = "var(--color-bg-1)",
  title,
}: RailAvatarProps) {
  const hover = title ?? presenceTitle(actor.name, actor.state);
  return (
    <span
      className="relative inline-flex flex-shrink-0 leading-none"
      style={{ width: size, height: size }}
      title={hover}
    >
      {actor.kind === "agent" ? (
        <AgentIcon
          agentId={actor.agentKind ?? actor.name.toLowerCase()}
          label={actor.name}
          size={size}
        />
      ) : (
        <Avatar
          name={actor.name}
          size={size}
          src={actor.avatar ?? null}
          presence={null}
          title={hover}
        />
      )}
      {showPresence ? (
        <PresenceDot
          state={actor.state}
          name={actor.name}
          size={dotSize(size)}
          ring={ring}
        />
      ) : null}
    </span>
  );
}

/**
 * The same avatar, dimmed when the actor isn't here.
 *
 * Used by the pip cluster, where a participant who has dropped out should
 * still be visible — they were in this room a minute ago — without competing
 * with the two people who still are.
 */
export function RailAvatarDimmable(props: RailAvatarProps) {
  const away = !isPresent(props.actor.state);
  return (
    <span style={away ? { opacity: 0.45 } : undefined}>
      <RailAvatar {...props} />
    </span>
  );
}
