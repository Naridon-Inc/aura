// ActorMark — the identity chip for one radar actor. Two kinds, never a dot:
//   • an AGENT reads as its brand: the app's agent mark (Claude, Gemini,
//     Codex, Cursor, Kimi, opencode), falling back to the Aura mark for an
//     agent it doesn't know.
//   • a HUMAN reads as the library avatar with their monogram — the same
//     disc a crew task's assignee wears.
//
// The human branch used to hash the name into one of twelve AI-generated
// photographic portraits. That put a photorealistic face of a person who does
// not exist next to a real teammate's name, in a panel whose entire job is
// telling you who is touching your code — the one surface that must never
// invent an identity. A monogram is honestly a placeholder; a stranger's face
// is not. The app's person avatar has since learned to fetch exactly such a
// generated portrait when it has no real photo, so this mark no longer goes
// through it: the library avatar draws the monogram and nothing else.

import { Avatar, AvatarFallback } from "../../ui/avatar";
import { AgentIcon } from "../../agent/AgentIcon";
import { monogram } from "../../../lib/monogram";
import { actorShort } from "./radarFormat";
import "../../ui/radar-rows.css";

// The agents the radar knows by sight, keyed by the short actor handle
// (transport suffix already stripped), lowercased. Any other agent wears the
// Aura mark rather than a guessed logo.
const BRANDED = new Set(["claude", "gemini", "codex", "cursor", "kimi", "opencode"]);

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
    return (
      <span className="ui-radar-mark" title={actor}>
        <AgentIcon agentId={BRANDED.has(key) ? key : "aura"} label={actor} size={size} />
      </span>
    );
  }
  return (
    <Avatar className="ui-radar-avatar" style={{ width: size, height: size }} title={actor}>
      <AvatarFallback style={{ fontSize: Math.round(size * 0.42) }}>
        {monogram(actorShort(actor))}
      </AvatarFallback>
    </Avatar>
  );
}
