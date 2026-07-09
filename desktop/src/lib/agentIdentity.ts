// Agent identity registry — single source of truth used everywhere an
// agent is mentioned in chat, dispatch strips, wave timeline, scout
// cards, task tree. Colors mirror Cursor's AI-timeline palette
// (peach/sky/lavender/sage) so each agent has a stable, recognisable
// "personality" across the app.
//
// New agent: add an entry below; AgentIcon already resolves the brand
// mark from `/public/app-icons/`.

export type AgentRole = "lead" | "sub" | "specialist" | "manager";

export type AgentIdentity = {
  /** Canonical agent id (matches the values brain backends emit). */
  id: string;
  /** Human label rendered in chips and timeline rows. */
  label: string;
  /** Short tag used in `[BRACKETED]` mono headers. */
  tag: string;
  /** Semantic accent — Cursor AI-timeline palette: peach (thinking),
   *  sky (read), sage (grep), lavender (edit), crimson (security). */
  accent: string;
  /** Default role in a typical plan; UI may override per-task. */
  defaultRole: AgentRole;
  /** One-line description for hover/tooltip context. */
  blurb: string;
};

// Cursor AI-timeline tokens (DESIGN.md §2): thinking #dfa88f, grep
// #9fc9a2, read #9fbbe0, edit #c0a8dd, error/security #cf2d56.
const COLOR = {
  thinking: "#dfa88f", // peach — Claude (planning/build lead)
  read: "#9fbbe0", // sky — Gemini (research/skim)
  edit: "#c0a8dd", // lavender — Cursor (refactor/UI)
  grep: "#9fc9a2", // sage — Codex (search/patch)
  security: "#cf2d56", // crimson — Security specialist
  success: "#1f8a65", // teal — Manager / shipped state
  pi: "#d9b25f", // amber — Pi (provider-agnostic / local harness)
};

const REGISTRY: AgentIdentity[] = [
  {
    id: "aura-manager",
    label: "Aura",
    tag: "MANAGER",
    accent: COLOR.success,
    defaultRole: "manager",
    blurb: "Orchestrates the plan, dispatches subagents, watches for stalls.",
  },
  {
    id: "claude",
    label: "Claude Code",
    tag: "CLAUDE",
    accent: COLOR.thinking,
    defaultRole: "lead",
    blurb: "Lead-builder. Long-context planning, multi-file edits.",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    tag: "GEMINI",
    accent: COLOR.read,
    defaultRole: "sub",
    blurb: "Fast research, large-codebase skim, first-pass implementation.",
  },
  {
    id: "cursor",
    label: "Cursor Agent",
    tag: "CURSOR",
    accent: COLOR.edit,
    defaultRole: "sub",
    blurb: "UI work, surgical refactors, in-editor execution.",
  },
  {
    id: "codex",
    label: "Codex",
    tag: "CODEX",
    accent: COLOR.grep,
    defaultRole: "sub",
    blurb: "Code search, small focused patches.",
  },
  {
    id: "pi",
    label: "Pi",
    tag: "PI",
    accent: COLOR.pi,
    defaultRole: "sub",
    blurb: "Provider-agnostic terminal harness — BYO key, runs Claude / GPT / Gemini / local models.",
  },
  // Scout specialists — Architecture / Security / UX.
  {
    id: "architecture",
    label: "Architecture",
    tag: "ARCH",
    accent: COLOR.read,
    defaultRole: "specialist",
    blurb: "Layering, coupling, prerequisite gaps, scaffolding assumptions.",
  },
  {
    id: "security",
    label: "Security",
    tag: "SECURITY",
    accent: COLOR.security,
    defaultRole: "specialist",
    blurb: "AuthZ, IDOR, XSS, secrets handling, token storage.",
  },
  {
    id: "ux",
    label: "UX",
    tag: "UX",
    accent: COLOR.edit,
    defaultRole: "specialist",
    blurb: "User flows, state coverage, ownership/auth surfaces, moderation paths.",
  },
];

const FALLBACK: AgentIdentity = {
  id: "unknown",
  label: "Agent",
  tag: "AGENT",
  accent: "var(--color-text-2)",
  defaultRole: "sub",
  blurb: "",
};

/** Collapse the generic MCP-server label onto the real coding agent. Every
 *  intent Aura logged over MCP historically carried `agent_id: "MCP Agent"` —
 *  but the MCP server is always driven by a real CLI agent (here, Claude Code).
 *  Newer engine builds capture the true client at the `initialize` handshake;
 *  for the legacy rows we resolve the generic label to Claude so a session
 *  reads as its actual agent (logo + name) instead of a confusing "MCP Agent"
 *  monogram. Any other id passes through untouched. */
export function canonicalAgentId(agentId: string | null | undefined): string {
  const raw = (agentId ?? "").trim();
  if (!raw) return "";
  // Normalise separators so "mcp-agent", "mcp_agent", "MCP  Agent" all align.
  const norm = raw.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  // The generic MCP fallback label — the server couldn't name its client, so
  // it stamped a placeholder. In this repo that client is always Claude Code
  // (Codex/Gemini/etc. carry their own ids). Collapse every placeholder form
  // ("mcp", "mcp agent", "mcp connected agent", "mcp client") onto Claude.
  if (norm === "mcp" || norm === "mcp client" || /^mcp\b.*\bagent$/.test(norm)) {
    return "claude";
  }
  return raw;
}

/** Resolve an agent identity by id. Matches by exact id first, then by
 *  substring (so `cli:claude`, `cli:claude-code-1m`, etc all land on
 *  the Claude entry). Falls back to a neutral identity if nothing
 *  matches — never throws. */
export function getAgentIdentity(agentId: string | null | undefined): AgentIdentity {
  if (!agentId) return FALLBACK;
  const canonical = canonicalAgentId(agentId);
  const id = canonical.toLowerCase();
  const exact = REGISTRY.find((a) => a.id === id);
  if (exact) return exact;
  // Order matters here for substrings — `cursor-agent` must beat
  // `cursor`, so iterate longest-id-first.
  const sorted = [...REGISTRY].sort((a, b) => b.id.length - a.id.length);
  for (const a of sorted) {
    if (id.includes(a.id)) return a;
  }
  return { ...FALLBACK, id: canonical, label: canonical };
}

export function listAgentIdentities(): AgentIdentity[] {
  return REGISTRY.slice();
}

/** Friendly display label for any agent id, used by `AgentBadge` so every
 *  surface shows the same human name. Covers three cases the raw registry
 *  lookup misses:
 *   - Aura's own built-in agent (`ai` / `ai@aura.vcs`) → "Aura Agent".
 *   - A real registry hit → its label ("claude" → "Claude Code").
 *   - A bare `name@host` id → just the local part.
 *  Note we deliberately do NOT add an "ai" entry to the REGISTRY: its
 *  substring match would wrongly claim ids like "openai". */
export function agentDisplayLabel(agentId: string | null | undefined): string {
  const canonical = canonicalAgentId(agentId);
  if (!canonical) return "Agent";
  const lower = canonical.toLowerCase();
  if (lower === "ai" || lower.startsWith("ai@")) return "Aura Agent";
  const identity = getAgentIdentity(canonical);
  // A registry hit renames the id (e.g. "claude" → "Claude Code"); the
  // fallback returns label === the raw id, so an unchanged label means miss.
  if (identity.label && identity.label.toLowerCase() !== lower) {
    return identity.label;
  }
  const at = canonical.indexOf("@");
  return at > 0 ? canonical.slice(0, at) : canonical;
}

/** Tailwind/CSS-friendly token: `color-mix(in srgb, <accent> X%, <base>)`
 *  for tinted backgrounds without committing to a fixed hex. */
export function accentTint(accent: string, percent: number, base = "transparent"): string {
  return `color-mix(in srgb, ${accent} ${percent}%, ${base})`;
}
