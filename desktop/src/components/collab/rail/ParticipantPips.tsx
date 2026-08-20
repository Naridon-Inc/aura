// Who is in the room — four overlapping discs under a live session row.
//
// The one fact this has to carry is "two people and their two agents are in
// here", read without stopping. So the order is by owner (person, then the
// agents that are theirs — see `orderPips`), the discs overlap so the cluster
// reads as one group rather than four separate marks, and each one keeps a
// ring in the rail's surface colour so the overlap stays legible.
//
// No presence dots at this size: four 5px dots on four 14px discs is a texture,
// not information. Someone who has dropped out is dimmed instead, and the
// cluster's hover text names everyone in full.

import { actorLabel } from "./railActivity";
import {
  isPresent,
  orderPips,
  presenceLabel,
  type RailActor,
} from "./railModel";
import { RailAvatarDimmable } from "./RailAvatar";

export type ParticipantPipsProps = {
  participants: RailActor[];
  /** Every actor on the rail, so an agent can be named by whose it is. */
  byId: Map<string, RailActor>;
  /** How many discs before the cluster collapses to "+N". Four is the shape
   *  this feature is about; a fifth is already a crowd. */
  max?: number;
  /** Disc diameter in px. */
  size?: number;
  /** The surface the rings are punched out of. */
  ring?: string;
};

/** `Ashiq · writing code` — one line of the cluster's hover text. */
function pipTitle(actor: RailActor, byId: Map<string, RailActor>): string {
  return `${actorLabel(actor, byId, true)} · ${presenceLabel(
    actor.state,
  ).toLowerCase()}`;
}

export function ParticipantPips({
  participants,
  byId,
  max = 4,
  size = 14,
  ring = "var(--color-bg-1)",
}: ParticipantPipsProps) {
  const ordered = orderPips(participants);
  // Nobody in the room is not an empty cluster to draw — it is a row with no
  // cluster at all, which is what "quiet" looks like.
  if (ordered.length === 0) return null;

  const shown = ordered.slice(0, max);
  const more = ordered.length - shown.length;
  const here = ordered.filter((p) => isPresent(p.state)).length;
  const hover = ordered.map((p) => pipTitle(p, byId)).join("\n");

  return (
    <span
      className="inline-flex items-center"
      title={hover}
      aria-label={`${here} in this session`}
    >
      {shown.map((actor, i) => (
        <span
          key={actor.id}
          className="relative inline-flex rounded-full"
          style={{
            marginLeft: i === 0 ? 0 : -Math.round(size * 0.3),
            // The ring is what keeps four overlapping discs from reading as
            // one smear. It is the surface colour, not a line colour, so the
            // cluster looks cut out of the rail rather than outlined on it.
            boxShadow: `0 0 0 1.5px ${ring}`,
            borderRadius: 999,
            zIndex: shown.length - i,
          }}
        >
          <RailAvatarDimmable actor={actor} size={size} />
        </span>
      ))}
      {more > 0 ? (
        <span
          className="text-2xs tabular-nums text-text-4 leading-none"
          style={{ marginLeft: 4 }}
        >
          +{more}
        </span>
      ) : null}
    </span>
  );
}
