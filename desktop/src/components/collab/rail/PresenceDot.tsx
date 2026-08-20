// The dot on a person's avatar — are they here, and are they doing anything.
//
// It rides the avatar's bottom-right corner with a ring in the rail's own
// surface colour, so it reads as attached to the person rather than as a
// separate mark floating beside them. `presenceInk` decides the paint and
// `presenceTitle` the words; both live in railModel so the rule is stated once
// and this file only draws it.
//
// The tooltip is the real one (the app mounts a TooltipProvider at the root),
// not a `title` attribute, because this dot is the only thing in the rail whose
// meaning isn't written next to it — everything else here is a word.

import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import {
  presenceInk,
  presenceLabel,
  presenceTitle,
  type RailPresenceState,
} from "./railModel";

export type PresenceDotProps = {
  state: RailPresenceState;
  /** Whose dot it is. Named in the tooltip; omit for a legend or a key. */
  name?: string;
  /** Diameter in px. 7 on a person's 22px avatar, 5 on a 14px pip. */
  size?: number;
  /** The surface the dot is punched out of. Bare (no ring) when the dot is on
   *  a line of text rather than over an avatar. */
  ring?: string | null;
  className?: string;
};

/**
 * The dot on its own, with no tooltip — for stacking inside something that
 * already explains itself (a pip cluster whose own hover text names everyone).
 */
export function PresenceMark({
  state,
  size = 7,
  ring = "var(--color-bg-1)",
  className,
}: Omit<PresenceDotProps, "name">) {
  const ink = presenceInk(state);
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: "block",
        width: size,
        height: size,
        borderRadius: 999,
        // Filled means "doing something". A ring means present but passive, or
        // gone — the shape carries as much as the colour does at this size.
        background: ink.filled ? ink.color : "transparent",
        border: ink.filled ? "none" : `1.5px solid ${ink.color}`,
        boxShadow: ring ? `0 0 0 1.5px ${ring}` : undefined,
      }}
    />
  );
}

/**
 * The dot, positioned on an avatar, with the plain-language tooltip.
 *
 * Mount it inside a `position: relative` wrapper — `RailAvatar` provides one.
 */
export function PresenceDot({
  state,
  name,
  size = 7,
  ring = "var(--color-bg-1)",
  className,
}: PresenceDotProps) {
  const label = name ? presenceTitle(name, state) : presenceLabel(state);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`absolute ${className ?? ""}`}
          style={{ right: -1, bottom: -1, lineHeight: 0 }}
          role="img"
          aria-label={label}
        >
          <PresenceMark state={state} size={size} ring={ring} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
