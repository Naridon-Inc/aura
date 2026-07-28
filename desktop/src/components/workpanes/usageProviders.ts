// Shared provider/model helpers for the Trace Overview team + usage sections.
//
// HONESTY RULE (inherited from OverviewPane): nothing here fabricates data.
// These are pure mapping/formatting helpers — model string → provider id,
// provider id → calm brand accent, and token/cost/relative-time formatting.
// The brand accents reuse the SAME theme tokens AgentIcon's `brandFor` uses
// so the logos and the bars agree on color without re-hardcoding hexes.

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
 *  `providerForModel` returns, or a raw sentinel/intent `agent_id`). Maps the
 *  known vendors to their product name so the by-agent breakdown reads
 *  "Claude / Gemini / Codex / Cursor"; unknown ids are title-cased rather
 *  than invented. */
export function providerLabel(id: string): string {
  const s = (id ?? "").toLowerCase().trim();
  if (!s || s === "unknown") return "Unknown";
  // Aura's own built-in agent shows up in the intent log as ai@aura.vcs.
  if (s === "ai" || s.startsWith("ai@") || s.includes("aura")) return "Aura Agent";
  if (s.includes("claude") || s.includes("anthropic")) return "Claude";
  if (s.includes("gemini") || s.includes("google")) return "Gemini";
  if (s.includes("codex") || s.includes("openai") || s.includes("gpt")) return "Codex";
  if (s.includes("cursor")) return "Cursor";
  if (s === "openai-compat" || s.startsWith("openai-compat")) return "Local model";
  // A stray slug ("ada@x.com" / "some-agent") — drop any email host and
  // title-case the first segment so it still reads as a name.
  const at = s.indexOf("@");
  const base = at > 0 ? s.slice(0, at) : s;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Calm brand accent (a single CSS color expression) for a provider id.
 *  Mirrors AgentIcon.brandFor's foreground so bars match the logos. Used
 *  for the per-model split bar + per-dev token tints. */
export function providerAccent(providerId: string): string {
  const id = (providerId ?? "").toLowerCase();
  if (id.includes("claude")) return "var(--color-caret-orange)";
  if (id.includes("gemini")) return "var(--color-blue)";
  if (id.includes("codex") || id.includes("openai")) return "var(--color-green)";
  if (id.includes("cursor")) return "var(--color-violet)";
  if (id === "openai-compat" || id.startsWith("openai-compat")) {
    // No pack defines `--color-teal`, so this bar drew a hard-coded teal that
    // ignored every theme. A compat endpoint is OpenAI-shaped but is not
    // OpenAI, so it reads as the codex green pulled back toward the surface —
    // same family, visibly quieter.
    return "color-mix(in srgb, var(--color-green) 58%, var(--color-text-3))";
  }
  if (id.includes("aura")) return "var(--color-accent)";
  return "var(--color-text-3)";
}

/** Compact token count — 1234 → "1.2k", 2_400_000 → "2.4M". Never rounds
 *  small values into thin air; <1000 shows the exact integer. */
export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(v < 10_000_000 ? 1 : 0)}M`;
  return `${(v / 1_000_000_000).toFixed(1)}B`;
}

/** USD cost — "$0.0042" under a cent, "$1.20" otherwise, "$3.4k" big. */
export function fmtCost(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${(v / 1000).toFixed(1)}k`;
}

/** Relative time from an absolute unix-seconds timestamp. Shared with the
 *  solo pane's relTime semantics, but takes an absolute ts + a now clock so
 *  callers can keep one shared clock per render. */
export function relTimeFromTs(tsSecs: number, nowSecs: number): string {
  if (!Number.isFinite(tsSecs) || tsSecs <= 0) return "—";
  const secsAgo = nowSecs - tsSecs;
  if (secsAgo < 0) return "just now";
  if (secsAgo < 45) return "just now";
  const mins = Math.floor(secsAgo / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(secsAgo / 3600);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(secsAgo / 86400);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Monogram initials from a display name / handle / email — up to two
 *  letters, uppercased. Used for teammate avatars when there's no photo. */
export function initialsOf(label: string): string {
  const s = (label ?? "").trim();
  if (!s) return "?";
  const at = s.indexOf("@");
  const base = at > 0 ? s.slice(0, at) : s;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return base.charAt(0).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
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
