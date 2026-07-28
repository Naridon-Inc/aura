// ActorMark — the identity chip for one radar actor. Two kinds, never a dot:
//   • an AGENT reads as its brand: the vendor logo (Claude, Gemini, Codex,
//     Cursor, Kimi, opencode) in a neutral bordered tile, falling back to the
//     Aura mark for an unknown agent.
//   • a HUMAN reads as the same monogram disc they carry everywhere else in
//     the app (Team, sidebar, message bubbles), tinted deterministically from
//     their name, and showing their real profile photo when one is known.
//
// The human branch used to hash the name into one of twelve AI-generated
// photographic portraits. That put a photorealistic face of a person who does
// not exist next to a real teammate's name, in a panel whose entire job is
// telling you who is touching your code — the one surface that must never
// invent an identity. A tinted monogram is honestly a placeholder; a stranger's
// face is not.

import { AuraMark } from "../../AuraMark";
import { Avatar } from "../../team/presentation/Avatar";
import { actorShort } from "./radarFormat";

// Same-origin brand SVGs bundled under /public/app-icons. Keyed by the short
// actor handle (transport suffix already stripped), lowercased.
const AGENT_ICON: Record<string, string> = {
  claude: "/app-icons/claude.svg",
  gemini: "/app-icons/gemini.svg",
  codex: "/app-icons/codex-white.svg",
  cursor: "/app-icons/cursor.svg",
  kimi: "/app-icons/kimi.svg",
  opencode: "/app-icons/opencode-white.svg",
};

export function ActorMark({
  actor,
  isAgent,
  size = 16,
}: {
  actor: string;
  isAgent: boolean;
  size?: number;
}) {
  if (isAgent) {
    const key = actorShort(actor).toLowerCase();
    const src = AGENT_ICON[key];
    const inner = Math.round(size * 0.66);
    return (
      <span
        className="grid shrink-0 place-items-center rounded-md border border-line-soft bg-bg-2"
        style={{ width: size, height: size }}
        title={actor}
      >
        {src ? (
          <img
            src={src}
            alt=""
            width={inner}
            height={inner}
            draggable={false}
            style={{ objectFit: "contain" }}
          />
        ) : (
          <AuraMark size={inner} style={{ color: "var(--color-text-2)" }} />
        )}
      </span>
    );
  }
  return <Avatar name={actor} size={size} title={actor} />;
}
