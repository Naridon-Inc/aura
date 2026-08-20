/** Team (chat) bounded context — references-grade Avatar.
 *
 *  The ui-level person avatar for the new Team surface: a deterministic
 *  tinted disc carrying the person's animal monogram, sized for the
 *  conversation list / header / roster (references-grade ~30px, not the
 *  old cramped 16px rail dot), with an optional presence dot. Colour +
 *  animal come from the shared `identityColors` hash so the same person
 *  reads identically here, in the sidebar, and in message bubbles.
 *
 *  Every human face in the app comes through here — commit rows, the roster,
 *  message bubbles, PR authors, page comments, the collab rail, @-mentions —
 *  so the ladder of what a person's face can be is decided in one place:
 *
 *    1. `src` — a photo that is really theirs (self-picked, or GitHub),
 *       resolved by `memberAvatar.ts`. Always wins.
 *    2. a generated portrait claimed once for their identity and then held on
 *       this machine (`lib/fallbackAvatars.ts`).
 *    3. the deterministic animal monogram, which is what draws until (and
 *       unless) 2 arrives, and what stays forever if it never does. */

import { useEffect, useState } from "react";

import {
  animalForName,
  colorForName,
  tintForName,
} from "../../../lib/identityColors";
import { useFallbackAvatar } from "../../../lib/useFallbackAvatar";

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
  /** The stable id this person's generated portrait is filed under — their
   *  email or GitHub login where the surface knows it. Defaults to `name`,
   *  which is the same key the animal monogram already hashes on, so a caller
   *  that only has a display name still gets one steady face rather than a new
   *  one per render. Pass the stronger id wherever you have it: two people who
   *  share a display name should not share a portrait. */
  identity?: string | null;
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
  identity,
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
  const hasRealPhoto = !!src && !broken;
  // Only ask for a generated portrait once the real photo is out of the running
  // — either there never was one, or the one we had failed to load. A person
  // with a picture costs no lookup and no request.
  const generated = useFallbackAvatar(identity ?? name, !hasRealPhoto);
  // The generated portrait gets its own failure flag rather than sharing the
  // one above: a portrait that won't decode must drop to the monogram, not
  // re-flag the real photo it already stood in for.
  const [generatedBroken, setGeneratedBroken] = useState(false);
  useEffect(() => {
    setGeneratedBroken(false);
  }, [generated]);
  const photo = hasRealPhoto ? src : generatedBroken ? null : generated;
  const showPhoto = !!photo;
  const onPhotoError = hasRealPhoto
    ? () => setBroken(true)
    : () => setGeneratedBroken(true);
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
            src={photo ?? undefined}
            alt=""
            className="h-full w-full object-cover"
            style={{ borderRadius: radius }}
            draggable={false}
            onError={onPhotoError}
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
