/** Team (chat) bounded context — references-grade Avatar.
 *
 *  The ui-level person avatar for the new Team surface: a deterministic
 *  tinted disc carrying the person's animal monogram, sized for the
 *  conversation list / header / roster (references-grade ~30px, not the
 *  old cramped 16px rail dot), with an optional presence dot. Colour +
 *  animal come from the shared `identityColors` hash so the same person
 *  reads identically here, in the sidebar, and in message bubbles. */

import { useEffect, useState } from "react";

import {
  animalForName,
  colorForName,
  tintForName,
} from "../../../lib/identityColors";

export type Presence = "online" | "idle" | "offline";

type AvatarProps = {
  name: string;
  /** Diameter in px. References-grade default is 30; rosters use ~24. */
  size?: number;
  /** `circle` for people/DMs, `rounded` for channel-style tiles. */
  shape?: "circle" | "rounded";
  /** When set, draws a presence dot at the bottom-right corner. */
  presence?: Presence | null;
  title?: string;
  /** Optional profile photo. The deterministic animal remains the fallback. */
  src?: string | null;
};

const PRESENCE_COLOR: Record<Presence, string> = {
  online: "var(--color-accent-green)",
  idle: "var(--color-amber)",
  offline: "var(--color-text-5)",
};

export function Avatar({
  name,
  size = 30,
  shape = "circle",
  presence = null,
  title,
  src,
}: AvatarProps) {
  const radius = shape === "circle" ? 9999 : Math.round(size * 0.28);
  const dot = Math.max(8, Math.round(size * 0.3));
  // A photo can 404 (a GitHub login with no picture, offline, a stale URL).
  // When it does, fall back to the deterministic animal so nobody ever shows
  // a broken-image glyph. Reset the flag when the src changes to a new photo.
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [src]);
  const showPhoto = !!src && !broken;
  return (
    <span
      className="relative inline-flex flex-shrink-0 select-none"
      style={{ width: size, height: size }}
      title={title ?? name}
    >
      <span
        className="flex items-center justify-center w-full h-full leading-none"
        style={{
          background: tintForName(name),
          color: colorForName(name),
          borderRadius: radius,
          fontSize: Math.round(size * 0.46),
        }}
      >
        {showPhoto ? (
          <img
            src={src ?? undefined}
            alt=""
            className="h-full w-full object-cover"
            style={{ borderRadius: radius }}
            draggable={false}
            onError={() => setBroken(true)}
          />
        ) : (
          animalForName(name)
        )}
      </span>
      {presence && (
        <span
          className="absolute rounded-full"
          style={{
            width: dot,
            height: dot,
            right: -1,
            bottom: -1,
            background: PRESENCE_COLOR[presence],
            boxShadow: "0 0 0 2px var(--color-bg-1)",
          }}
          aria-hidden
        />
      )}
    </span>
  );
}
