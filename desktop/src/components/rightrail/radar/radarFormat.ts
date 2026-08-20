// Formatting helpers for the Team Radar (awareness plane) surface. Pure
// functions over the raw api shapes — no React, no state — so the section
// components stay presentational. The CLI already did the scoring and
// noise-damping; this is purely cosmetic mapping.

import type { RadarCollision } from "../../../lib/api";
import { relativeAge, relativeAgeFromDelta } from "../../../lib/relativeTime";

/** Compact "now" / "5s" / "3m" / "2h" / "4d" from a millisecond age. */
export function agoFromMs(ms: number | null | undefined): string {
  // One ladder for the whole app — see lib/relativeTime. This copy stopped at
  // days, so a zone nobody had touched for a year read "412d".
  if (ms == null || ms < 0) return "—";
  return relativeAgeFromDelta(ms / 1000, { style: "compact" });
}

/** Compact age from a Unix-millisecond timestamp (the event `ts`). */
export function agoFromTs(tsMs: number | null | undefined): string {
  return relativeAge(tsMs ?? 0, { style: "compact", empty: "—" });
}

/** A small glyph per awareness kind — mirrors the CLI feed glyphs so the two
 *  surfaces read the same. */
export function kindGlyph(kind: string): string {
  switch (kind) {
    case "editing":
      return "✎";
    case "intent":
      return "✱";
    case "impact":
      return "⚡";
    case "zone":
      return "▢";
    case "paused":
      return "⏸";
    case "abandoned":
      return "⊘";
    case "committed":
      return "✓";
    case "started":
      return "▸";
    default:
      return "·";
  }
}

// Code extensions we strip when a raw file path stands in for a symbol, so
// "passwordReset.ts" reads as "password reset", not "password reset ts".
const CODE_EXT = /\.(tsx?|jsx?|rs|py|go|java|rb|md|json|toml|css|html)$/i;

/** Turn a raw code identifier into plain words a non-engineer can read:
 *  `createSession` → "create session", `sendResetEmail` → "send reset email",
 *  `requestPasswordReset` → "request password reset", `passwordReset.ts` →
 *  "password reset". Splits camelCase/PascalCase, snake_case and kebab-case,
 *  strips any leading path + code extension, and lowercases the result. */
export function humanizeSymbol(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw;
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(CODE_EXT, "");
  s = s.replace(/[_-]+/g, " ");
  // camelCase / PascalCase word boundaries, plus acronym→word (HTTPServer).
  s = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  s = s.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** A plain-language, one-line status for an Activity row — the human answer to
 *  "what is this person actually doing?". Prefers the actor's own stated intent
 *  (their words win); otherwise describes the piece of work in plain English
 *  keyed off the awareness kind, with no function names or git jargon leaking
 *  through (the ADE audience is non-engineers). */
export function activityStatus(e: {
  kind: string;
  symbol?: string | null;
  file?: string | null;
  intent?: string | null;
}): string {
  const intent = e.intent?.trim();
  if (intent) return intent;
  const what = humanizeSymbol(e.symbol || e.file || "");
  if (!what) return kindLabel(e.kind);
  switch (e.kind) {
    case "editing":
      return `working on ${what}`;
    case "started":
      return `picked up ${what}`;
    case "intent":
      return `planning ${what}`;
    case "committed":
      return `finished ${what}`;
    case "paused":
      return `paused ${what}`;
    case "abandoned":
      return `set aside ${what}`;
    case "impact":
      return `${what} affects other code`;
    case "zone":
      return `claimed ${what}`;
    default:
      return `${kindLabel(e.kind)} ${what}`;
  }
}

/** Human label for an awareness kind. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "editing":
      return "editing";
    case "intent":
      return "intends";
    case "impact":
      return "impact";
    case "zone":
      return "claimed zone";
    case "paused":
      return "paused";
    case "abandoned":
      return "abandoned";
    case "committed":
      return "committed";
    case "started":
      return "started";
    default:
      return kind;
  }
}

export type SeverityMeta = {
  label: string;
  /** Dot color — status hues only (the arctic accent stays reserved for
   *  primary affordances like Go Live, never a warning chip). */
  color: string;
  /** A one-word disposition shown after the peer. */
  disposition: string;
};

/** Severity → label + status color + disposition word. direct = head-on
 *  (red), likely = real risk (amber), possible = a quiet ripple (muted). */
export function severityMeta(severity: RadarCollision["severity"]): SeverityMeta {
  switch (severity) {
    case "direct":
      return { label: "direct", color: "var(--color-red)", disposition: "coordinate" };
    case "likely":
      return { label: "likely", color: "var(--color-amber)", disposition: "heads-up" };
    case "possible":
    default:
      return { label: "possible", color: "var(--color-text-4)", disposition: "fyi" };
  }
}

/** Strip an agent transport suffix for a compact label: "claude@cursor" →
 *  "claude". The full handle stays available in the tooltip. */
export function actorShort(actor: string): string {
  return actor.split("@")[0] || actor;
}

// Vendor handles that mean "this actor is a coding agent, not a person". Used
// where the source (a zone rule) carries a session id but no is_agent flag, so
// the row can still pick a brand logo over a human portrait.
const AGENT_NAME_HINTS = [
  "claude",
  "gemini",
  "codex",
  "cursor",
  "kimi",
  "opencode",
  "aider",
  "copilot",
  "aura-manager",
  "gpt",
  "llama",
  "qwen",
  "deepseek",
  "grok",
  "mistral",
];

/** Best-effort agent-vs-human guess from a bare name/session id (no is_agent
 *  flag available). Matches a known vendor handle exactly or as a prefix, so
 *  "gemini" and "codex@cli" read as agents while "priya" / "aura-shell" (the
 *  desktop's own session) read as people. */
export function nameLooksLikeAgent(name: string): boolean {
  const s = actorShort(name).toLowerCase();
  return AGENT_NAME_HINTS.some((k) => s === k || s.startsWith(k));
}
