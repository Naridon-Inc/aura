// Shared provider/model helpers for the Trace Overview team + usage sections.
//
// HONESTY RULE (inherited from OverviewPane): nothing here fabricates data.
// These are pure mapping/formatting helpers — model string → provider id,
// provider id → calm brand accent, and token/cost/relative-time formatting.
// The brand accents reuse the SAME theme tokens AgentIcon's `brandFor` uses
// so the logos and the bars agree on color without re-hardcoding hexes.

import { relativeAgeFromSecs } from "../../lib/relativeTime";
import { monogram } from "../../lib/monogram";
import { agentName } from "../../lib/agentNames";

/** Canonical provider id for a model or provider string. Returns an
 *  `agentId`-style token AgentIcon already understands (claude/gemini/
 *  codex/cursor/openai-compat) so the same logo logic applies. Unknown
 *  strings fall through to a stable lowercase slug for the monogram. */
export function providerForModel(raw: string): string {
  const s = (raw ?? "").toLowerCase().trim();
  if (!s) return "unknown";
  if (s.includes("claude") || s.includes("anthropic") || s.includes("sonnet") || s.includes("opus") || s.includes("haiku")) {
    return "claude";
  }
  if (s.includes("gemini") || s.includes("google")) return "gemini";
  if (s.includes("gpt") || s.includes("openai") || s.includes("codex") || s.includes("o1") || s.includes("o3") || s.includes("o4")) {
    return "codex";
  }
  if (s.includes("cursor")) return "cursor";
  if (s.includes("ollama") || s.includes("llama") || s.includes("mistral") || s.includes("qwen") || s.includes("deepseek") || s.includes("vllm")) {
    return "openai-compat";
  }
  return s;
}

/** A short, human label for a model id ("claude-3-5-sonnet" → "Sonnet"
 *  family-ish). Keeps the raw string when we can't simplify so we never
 *  mislabel. */
export function modelLabel(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "unknown";
  return s;
}

/** Friendly display name for a coding-agent / provider id (the value
 *  `providerForModel` returns, or a raw sentinel/intent `agent_id`), so the
 *  by-agent breakdown reads "Claude / Gemini / Codex / Cursor".
 *
 *  This was a ladder of substring tests, and `s.includes("openai")` sat one
 *  line above `s === "openai-compat"` — so a local model, the whole point of
 *  the compat adapter, was labelled "Codex". Matching on the canonical id
 *  instead of a substring is what makes that unreachable branch reachable.
 *  See lib/agentNames. */
export function providerLabel(id: string): string {
  return agentName(id, { empty: "Unknown", unknown: "Unknown" });
}

/** Calm brand accent (a single CSS color expression) for a provider id.
 *  Mirrors AgentIcon.brandFor's foreground so bars match the logos. Used
 *  for the per-model split bar + per-dev token tints. */
export function providerAccent(providerId: string): string {
  const id = (providerId ?? "").toLowerCase();
  if (id.includes("claude")) return "var(--color-caret-orange)";
  if (id.includes("gemini")) return "var(--color-blue)";
  // Before the codex test, not after it: "openai-compat" contains "openai",
  // so this branch could never be reached and a local model drew the full
  // Codex green. A compat endpoint is OpenAI-shaped but is not OpenAI, so it
  // reads as that green pulled back toward the surface — same family, visibly
  // quieter. (The comment here used to describe this fix from below the test
  // that pre-empted it.)
  if (id === "openai-compat" || id.startsWith("openai-compat")) {
    return "color-mix(in srgb, var(--color-green) 58%, var(--color-text-3))";
  }
  if (id.includes("codex") || id.includes("openai")) return "var(--color-green)";
  if (id.includes("cursor")) return "var(--color-violet)";
  if (id.includes("aura")) return "var(--color-accent)";
  return "var(--color-text-3)";
}

/** Relative time from an absolute unix-seconds timestamp. Shared with the
 *  solo pane's relTime semantics, but takes an absolute ts + a now clock so
 *  callers can keep one shared clock per render. */
export function relTimeFromTs(tsSecs: number, nowSecs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromSecs(tsSecs, {
    now: nowSecs * 1000,
    style: "compact",
    empty: "—",
  });
}

/** Monogram initials from a display name / handle / email — up to two
 *  letters, uppercased. Used for teammate avatars when there's no photo. */
export function initialsOf(label: string): string {
  // One monogram for the whole app — see lib/monogram. This one took the first two words, so
  // "Ada Byron Lovelace" read "AB" here and "AL" in the crew roster.
  return monogram(label);
}

/** Current month key "YYYY-MM" in local time — what cloud billing defaults
 *  to when no month is passed. We compute it ourselves only for the header
 *  label; the API still owns the actual scoping. */
export function currentMonthKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Pretty month label "2026-06" → "June 2026". Falls back to the raw key. */
export function prettyMonth(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec((key ?? "").trim());
  if (!m) return key || "";
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return key;
  return `${names[idx]} ${m[1]}`;
}
