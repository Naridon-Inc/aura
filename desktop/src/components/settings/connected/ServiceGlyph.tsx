// One mark per service, in one tile, so the list and the store agree.
//
// Vendor marks come from the brand SVGs already bundled under
// `public/app-icons` — the same files the radar reads. Never hand-drawn: a
// redrawn logo is a wrong logo, and these are other people's trademarks.
// Jira, Linear and Beads keep the hand-built glyphs beside them because no
// bundled asset exists for them and those three were authored, not traced.
// Anything with neither falls back to its own initial in the same tile, which
// is honestly a placeholder rather than a guess at somebody's brand.

import { BeadsGlyph, JiraGlyph, LinearGlyph } from "./trackerParts";
import type { ServiceId } from "./catalog";

/** Brand SVGs bundled same-origin. A service missing here has no mark we are
 *  entitled to draw. */
const BRAND: Partial<Record<ServiceId, string>> = {
  anthropic: "/app-icons/claude.svg",
  openai: "/app-icons/codex-white.svg",
  gemini: "/app-icons/gemini.svg",
};

export function ServiceGlyph({ id, label }: { id: ServiceId; label: string }) {
  if (id === "jira") return <JiraGlyph />;
  if (id === "linear") return <LinearGlyph />;
  if (id === "beads") return <BeadsGlyph />;

  const src = BRAND[id];
  return (
    <span
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line-soft bg-bg-2"
      aria-hidden
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={16}
          height={16}
          draggable={false}
          style={{ objectFit: "contain" }}
        />
      ) : (
        <span className="text-2xs font-medium uppercase text-text-3">
          {label.slice(0, 1)}
        </span>
      )}
    </span>
  );
}
