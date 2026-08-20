// What each agent and vendor is called — one table, app-wide.
//
// Six tables mapped an agent or provider id to a product name, each with a
// different membership. Transcribed verbatim and fed the same ids, 11 of 20
// got more than one answer:
//
//   id                answers across the six tables
//   "aura"            Aura (5) · Aura Agent (1) · Aura Pro (1)
//   "aura-manager"    Aura (2) · Aura Manager (2) · Aura-manager (2) · Aura Agent (1)
//   "openai"          Openai (3) · OpenAI (2) · GPT (1) · Codex (1)
//   "openai-compat"   Openai Compat (4) · Openai-compat (2) · Codex (1)
//   "cursor-agent"    Cursor Agent (4) · Cursor-agent (2) · Cursor (1)
//   "anthropic"       Anthropic (4) · Claude (3)
//   "deepseek"        Deepseek (6) · DeepSeek (1)
//   "opencode"        Opencode (6) · OpenCode (1)
//
// ── The one that is a defect, not a disagreement ─────────────────────────
//
// `openai-compat` is the adapter behind Local & Custom Models: Ollama, LM
// Studio, vLLM, Together, HuggingFace. It has its own settings tab, its own
// chat view, its own launcher entry, its own icon and its own Rust command,
// and its profiles live in ~/.aura/agents/openai-compat.json.
//
// workpanes/usageProviders tested `s.includes("openai")` one line ABOVE its
// own `s === "openai-compat"` branch, so that branch could never be reached.
// A private local model was labelled **"Codex"** in the by-agent usage
// breakdown — the app telling you your local model is OpenAI's product, and
// attributing free local tokens to a paid vendor. Its sibling providerAccent
// had the identical ordering bug, so a careful comment about pulling the
// colour back "same family, visibly quieter" described a branch that never
// ran.
//
// ── The two shapes that are genuinely different ──────────────────────────
//
//   agentName(id)   → the product a person chose: "Claude", "Codex", "Kimi",
//                     "Local model". What the launcher, the mission board and
//                     the session list mean by "which agent".
//   vendorName(id)  → who is billing you: "Anthropic", "OpenAI", "Google".
//                     What a cost or usage surface means by "provider".
//
// manager/chat/usageAtoms already drew this exact distinction — providerLabel
// said "Anthropic" while providerBrand said "Claude" — and it was the only one
// of the six that did. Both come off one table here, so a new agent is added
// in one place and cannot arrive with a vendor but no product name.

import { titleCaseName } from "./textCase";

type AgentEntry = {
  /** The product a person picked, as its makers spell it. */
  agent: string;
  /** Who bills for it. Equal to `agent` where the product IS the company. */
  vendor: string;
};

/** Keyed by canonical slug — see `canonicalAgentId`. */
const AGENTS: Record<string, AgentEntry> = {
  claude: { agent: "Claude", vendor: "Anthropic" },
  gpt: { agent: "GPT", vendor: "OpenAI" },
  codex: { agent: "Codex", vendor: "OpenAI" },
  gemini: { agent: "Gemini", vendor: "Google" },
  cursor: { agent: "Cursor", vendor: "Cursor" },
  "cursor-agent": { agent: "Cursor Agent", vendor: "Cursor" },
  kimi: { agent: "Kimi", vendor: "Moonshot" },
  qwen: { agent: "Qwen", vendor: "Alibaba" },
  deepseek: { agent: "DeepSeek", vendor: "DeepSeek" },
  ollama: { agent: "Ollama", vendor: "Ollama" },
  opencode: { agent: "OpenCode", vendor: "OpenCode" },
  // Published as `@earendil-works/pi-coding-agent`. The product is spelled
  // lowercase everywhere in its own copy; capitalised here because this is the
  // name that appears at the start of UI sentences.
  pi: { agent: "Pi", vendor: "Earendil Works" },
  amp: { agent: "Amp", vendor: "Sourcegraph" },
  windsurf: { agent: "Windsurf", vendor: "Windsurf" },
  aura: { agent: "Aura", vendor: "Aura" },
  // The paid brain, and a real distinction: plain `aura` is the free built-in
  // agent, and one of the six read it as "Aura Pro" — naming a tier the user
  // may not be on.
  "aura-pro": { agent: "Aura Pro", vendor: "Aura" },
  // Any OpenAI-shaped endpoint the user pointed at themselves. Not OpenAI.
  "openai-compat": { agent: "Local model", vendor: "Local model" },
};

/** Ids that mean an entry above under another name. */
const ALIASES: Record<string, string> = {
  anthropic: "claude",
  "claude-code": "claude",
  // As an AGENT id, OpenAI's product is the model, not the company; the
  // company comes back from vendorName via the `gpt` entry.
  openai: "gpt",
  google: "gemini",
  moonshot: "kimi",
  // The orchestrator is called Aura in the UI, never "Aura Manager".
  "aura-manager": "aura",
  // Aura's own built-in agent signs the intent log as ai@aura.vcs.
  ai: "aura",
  // Aura's pre-commit hook writes its own intents; that is Aura, not an agent
  // called "Hook Auto".
  "hook-auto": "aura",
};

/** The ids that mean "some agent, we were not told which". */
const GENERIC = new Set(["agent", "mcp-agent", "mcp-connected-agent"]);

/** An opaque machine identity — a DID or a long key. Never shown to a person.
 *
 *  askEngine treated ANY id containing a colon as opaque, which would also
 *  have erased a resolvable `cli:gemini`. No colon-prefixed id appears in this
 *  repo's intent log today, so this widens what resolves rather than changing
 *  what anyone currently sees. */
export function isOpaqueAgentId(raw: string | null | undefined): boolean {
  const s = (raw ?? "").trim().toLowerCase();
  return s.startsWith("did:") || s.length > 24;
}

/** A raw agent/provider/brain id reduced to the slug the tables are keyed by.
 *
 *  Handles the id shapes this app actually stores: a CLI-wrapper prefix
 *  (`cli:gemini`), a compat endpoint with a profile (`openai_compat:my-box`),
 *  a native-API suffix (`anthropic_native`), and an email-shaped identity
 *  (`ai@aura.vcs`). Also the spelling drift between `_` and `-`, which is why
 *  `aura_pro` and `aura-pro` were two different agents to two different
 *  surfaces. */
export function canonicalAgentId(raw: string | null | undefined): string {
  let s = (raw ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("openai_compat:") || s.startsWith("openai-compat:")) {
    return "openai-compat";
  }
  if (s.startsWith("did:")) return "";
  const colon = s.indexOf(":");
  if (colon >= 0) s = s.slice(colon + 1);
  const at = s.indexOf("@");
  if (at > 0) s = s.slice(0, at);
  s = s.replace(/_native$/, "").replace(/[\s_]+/g, "-");
  return ALIASES[s] ?? s;
}

export type AgentNameOptions = {
  /** No id at all. */
  empty?: string;
  /** An id that cannot be named at all — an opaque machine identity, or one
   *  of the placeholders that mean "some agent". A readable-but-unrecognised
   *  id is NOT this: it comes back title-cased, because saying what it calls
   *  itself is more honest than erasing it. */
  unknown?: string;
};

function lookup(raw: string | null | undefined): AgentEntry | null {
  const id = canonicalAgentId(raw);
  if (!id || GENERIC.has(id)) return null;
  return AGENTS[id] ?? null;
}

function fallback(
  raw: string | null | undefined,
  opts: AgentNameOptions | undefined,
): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return opts?.empty ?? "";
  const id = canonicalAgentId(raw);
  if (!id || GENERIC.has(id) || isOpaqueAgentId(trimmed)) {
    return opts?.unknown ?? opts?.empty ?? "";
  }
  // A name we do not have in the table — say what it calls itself, off the
  // canonical slug so a `cli:` prefix or an email host is already gone.
  return titleCaseName(id);
}

/** The product name a person recognises: "Claude", "Codex", "Local model". */
export function agentName(
  id: string | null | undefined,
  opts?: AgentNameOptions,
): string {
  return lookup(id)?.agent ?? fallback(id, opts);
}

/** The company behind it: "Anthropic", "OpenAI", "Google".
 *
 *  For a cost or usage surface, where the question is who charges you. */
export function vendorName(
  id: string | null | undefined,
  opts?: AgentNameOptions,
): string {
  return lookup(id)?.vendor ?? fallback(id, opts);
}
