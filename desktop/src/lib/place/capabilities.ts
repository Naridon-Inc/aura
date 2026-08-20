// What a place can run, asked once, in one way.
//
// The picker used to show all six agent CLIs on every box and let the session
// discover, one failed start at a time, that half of them aren't installed over
// there. Probing fixed that for boxes — and only for boxes, through a call that
// took a machine id and handed back a bare list of binary names, throwing away
// git, tmux and aura from the very same probe that found them.
//
// So the question "what can this place run" had a box-shaped answer with three
// quarters of it discarded, and this laptop could not be asked it at all. Both
// halves of that are the same bug: a capability is a property of a PLACE, so it
// is read off a place, all of it, through one call either mode can make.

import { api } from "../api";
import type { Place, PlaceCapabilities } from "./contract";

/** An agent CLI we might offer. `bin` is the binary name probed with
 *  `command -v` on the place; `id` is the canonical agent id the rest of the
 *  app knows it by. Not a capability claim on its own — this is the set we ASK
 *  each place about. */
export type AgentCandidate = { id: string; label: string; bin: string };

/** The full candidate set, in the order a picker should show them. */
export const AGENT_CANDIDATES: AgentCandidate[] = [
  { id: "claude", label: "Claude Code", bin: "claude" },
  { id: "codex", label: "Codex", bin: "codex" },
  { id: "gemini", label: "Gemini", bin: "gemini" },
  { id: "kimi", label: "Kimi", bin: "kimi" },
  { id: "opencode", label: "OpenCode", bin: "opencode" },
  { id: "pi", label: "Pi", bin: "pi" },
];

/** Just the binary names — what the capabilities probe is handed. */
export const AGENT_CANDIDATE_BINS: string[] = AGENT_CANDIDATES.map((a) => a.bin);

/** Ask a place what it can run. The single capabilities call.
 *
 *  One function for both place-modes, because it takes a `Place` rather than a
 *  machine id: a box goes to the box, and a here-place is answered by this
 *  laptop through the same probe script and the same parser. A second spelling
 *  for the local arm would agree for exactly as long as nobody fixed anything.
 *
 *  THROWS when the place can't be reached, and that is the useful half of the
 *  contract: an empty `agents` is the place's own answer, an exception is the
 *  absence of one. A caller that catches this must hold `null`, never `[]` —
 *  see `offerableAgents`. */
export function askCapabilities(
  place: Place,
  bins: string[] = AGENT_CANDIDATE_BINS,
): Promise<PlaceCapabilities> {
  return api.placeCapabilities(
    { root: place.project.root, machineId: place.machineId },
    bins,
  );
}

/** Which agents to offer, given what a place has said about itself.
 *
 *  `null` means we haven't asked yet, or the probe failed, or the place
 *  couldn't be reached — offer the full set rather than an empty picker,
 *  because **"we don't know" is not "it has none"**, and the session start
 *  still says plainly if a pick isn't there. An empty picker in front of
 *  somebody whose box was merely slow to answer tells them their machine is
 *  broken, which is both wrong and unactionable.
 *
 *  Once we DO have an answer, offer only the agents whose binary the place
 *  actually reported, in the canonical order — including none, when that is
 *  genuinely the answer. */
export function offerableAgents(
  capabilities: PlaceCapabilities | null,
): AgentCandidate[] {
  if (capabilities === null) return AGENT_CANDIDATES;
  const have = new Set(capabilities.agents);
  return AGENT_CANDIDATES.filter((a) => have.has(a.bin));
}

/** Keep the selected agent valid as the offerable set changes: hold the current
 *  pick if it's still installed, else fall to the first offered, else `""`
 *  (which the picker renders as "no agent installed on this place"). */
export function resolveSelectedAgent(
  current: string,
  offerable: AgentCandidate[],
): string {
  if (offerable.some((a) => a.id === current)) return current;
  return offerable[0]?.id ?? "";
}
