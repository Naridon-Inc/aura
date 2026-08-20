// Plain-language vocabulary for a shared coding session.
//
// A live session is the one surface where "who is this and what are they
// doing" has to be answerable at a glance — including by someone who does
// not read code. Every user-facing string in this folder comes from here, so
// the participants strip, the message row, the mention picker and the
// addressing bar can never describe the same person two different ways.
//
// The protocol's `Participant` has no owner pointer for agents; it does carry
// `user_id`, and an agent runs on behalf of exactly one person. So "whose
// Claude is this" is resolved by matching `user_id` against the humans in the
// same session — which is why every helper here takes the full roster.

import type { CSSProperties } from "react";
import type { Participant, ParticipantState } from "../../lib/sessionLive";

/** What each `state` means, in the words a non-engineer reads correctly.
 *  These are verb phrases: they complete "Shahabas is …". */
export const STATE_PHRASE: Record<ParticipantState, string> = {
  coding: "writing code",
  instructing: "telling an agent what to do",
  talking: "talking",
  watching: "watching",
  idle: "here, but not working on anything",
};

/** Short brand names for the CLIs an agent participant can be. The registry
 *  in `lib/agentIdentity` calls these "Claude Code" / "Gemini CLI", which is
 *  right for a picker of products and wrong inside a sentence about a
 *  teammate — "Shahabas's Claude Code is coding" reads as a product launch. */
const AGENT_BRAND_NAME: Record<string, string> = {
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
  cursor: "Cursor",
  kimi: "Kimi",
  opencode: "OpenCode",
  pi: "Pi",
};

/** The person an agent participant is running for, or null when the session
 *  has no human record carrying that `user_id` (they closed their tab while
 *  their agent kept running — a real state, not an error). */
export function ownerOf(
  p: Participant,
  all: readonly Participant[],
): Participant | null {
  if (p.kind !== "agent") return null;
  return (
    all.find((x) => x.kind === "human" && x.user_id === p.user_id) ?? null
  );
}

export function isYou(p: Participant, youId: string | null): boolean {
  return !!youId && p.id === youId;
}

/** The brand word for an agent — "Claude", "Gemini" — falling back to
 *  whatever name the socket announced. */
export function agentBrandName(p: Participant): string {
  const kind = (p.agent_kind ?? "").toLowerCase();
  return AGENT_BRAND_NAME[kind] ?? p.name ?? "agent";
}

/** The id `AgentIcon` resolves a brand mark from. */
export function agentIconId(p: Participant): string {
  return (p.agent_kind ?? p.name ?? "agent").toLowerCase();
}

/** How this participant is named everywhere: "You", "Shahabas",
 *  "Your Claude", "Shahabas's Claude". */
export function participantLabel(
  p: Participant,
  all: readonly Participant[],
  youId: string | null,
): string {
  if (p.kind === "human") return isYou(p, youId) ? "You" : p.name;
  const brand = agentBrandName(p);
  const owner = ownerOf(p, all);
  if (!owner) return brand;
  if (isYou(owner, youId)) return `Your ${brand}`;
  return `${possessive(owner.name)} ${brand}`;
}

/** The same label, but never "You" — for the places where the message is
 *  *about* you in the third person ("handed over to Ashiq"). */
export function participantName(
  p: Participant,
  all: readonly Participant[],
): string {
  if (p.kind === "human") return p.name;
  const owner = ownerOf(p, all);
  return owner ? `${possessive(owner.name)} ${agentBrandName(p)}` : agentBrandName(p);
}

/** Always `'s`, including after a trailing s — these are first names, and
 *  "Shahabas' Claude" reads as a typo to everyone who isn't a copy editor. */
function possessive(name: string): string {
  return `${name}'s`;
}

/** "Shahabas is watching" · "Your Claude is writing code" · "You are talking". */
export function activitySentence(
  p: Participant,
  all: readonly Participant[],
  youId: string | null,
): string {
  const subject = participantLabel(p, all, youId);
  const verb = p.kind === "human" && isYou(p, youId) ? "are" : "is";
  return `${subject} ${verb} ${STATE_PHRASE[p.state]}`;
}

/** The handle a mention inserts: `@shahabas`, `@shahabas-claude`. Kept to
 *  `[a-z0-9_.-]` so the existing chat markdown mention rule highlights it. */
export function mentionHandle(
  p: Participant,
  all: readonly Participant[],
): string {
  const slug = (s: string) =>
    s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (p.kind === "human") return slug(p.name) || "someone";
  const owner = ownerOf(p, all);
  const brand = slug(agentBrandName(p)) || "agent";
  return owner ? `${slug(owner.name)}-${brand}` : brand;
}

/** The presence dot. Two inks only — Aura's green for "doing something with
 *  the code", amber for "talking" — plus an outline for watching and a dim
 *  fill for idle. Red is reserved for errors, so no state uses it. */
export function presenceDotStyle(state: ParticipantState): CSSProperties {
  switch (state) {
    case "coding":
      return {
        background: "var(--color-accent)",
        boxShadow: "0 0 0 2px var(--color-bg-1), 0 0 0 3.5px color-mix(in srgb, var(--color-accent) 35%, transparent)",
      };
    case "instructing":
      return {
        background: "var(--color-accent)",
        boxShadow: "0 0 0 2px var(--color-bg-1)",
      };
    case "talking":
      return {
        background: "var(--color-amber)",
        boxShadow: "0 0 0 2px var(--color-bg-1)",
      };
    case "watching":
      return {
        background: "var(--color-bg-1)",
        border: "1.5px solid var(--color-text-3)",
        boxShadow: "0 0 0 2px var(--color-bg-1)",
      };
    case "idle":
    default:
      return {
        background: "var(--color-text-5)",
        opacity: 0.7,
        boxShadow: "0 0 0 2px var(--color-bg-1)",
      };
  }
}

/** "just joined" · "for 12 minutes" · "for 2 hours" — the duration half of a
 *  hover card, in words rather than a timestamp. `since` is epoch seconds. */
export function sinceWords(since: number): string {
  if (!since || since <= 0) return "";
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - since);
  if (secs < 45) return "just joined";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `for ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `for ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `for ${days} day${days === 1 ? "" : "s"}`;
}

/** People first, then agents, then by name — one stable order for the strip,
 *  the mention picker and the addressing menu. */
export function sortParticipants(all: readonly Participant[]): Participant[] {
  return [...all].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "human" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
