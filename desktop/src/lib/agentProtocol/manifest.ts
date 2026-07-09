//! Declarative per-agent manifest — the registry that makes a new coding
//! agent a CONFIG entry, not a code change.
//!
//! The Rust side (`aura-agents` crate) already owns invocation: the
//! `AgentProvider` trait + `Registry` + a TOML loader build the command line
//! and report `Capabilities { stream, pty, resume }`. This frontend manifest
//! is the rendering-side mirror: for each agent id it declares HOW its output
//! becomes `NormalizedEvent`s (the ingress) and WHICH rich interactions it can
//! surface, so the chat renderer adapts without per-agent branches.
//!
//! Adding an agent: drop a manifest entry here + an adapter under `adapters/`.
//! Unknown ids resolve to `genericManifest`, so an agent declared only in
//! `~/.aura/agents.toml` still renders (text/tool_call/result) — it just won't
//! claim rich interactions it can't actually emit until someone writes its
//! adapter. Nothing breaks; coverage degrades gracefully.

/** How an agent's output reaches us, which picks the normalizer. */
export type AgentIngress =
  /** Anthropic stream-json (Claude Code today; the cleanest protocol). */
  | "stream-json"
  /** Agent Client Protocol JSON-RPC (Gemini/Cursor/Goose via `--acp`). */
  | "acp"
  /** Engine-specific JSON event stream (Codex `--json`, Gemini stream-json). */
  | "json-events"
  /** No structured protocol — raw terminal only. Renders in xterm, no cards. */
  | "pty"
  /** OpenAI-compatible chat-completions (Ollama / HF endpoints). */
  | "chat";

/** Which rich interactions an agent can surface, so the renderer only offers
 *  affordances the engine actually drives. Conservative defaults — a flag is
 *  true only when its adapter genuinely maps the event. */
export type AgentInteractions = {
  /** Streams extended-thinking / reasoning we can show as a whisper. */
  reasoning: boolean;
  /** Emits tool calls we render as cards (vs opaque text). */
  toolCalls: boolean;
  /** Can ask the user a single question and consume the answer. */
  questions: boolean;
  /** Can ask a SET of questions at once (Claude AskUserQuestion, elicitation). */
  questionSets: boolean;
  /** Has a plan/propose phase we render as an approvable plan card. */
  plan: boolean;
  /** Gates tool calls behind an allow/deny permission round-trip. */
  permission: boolean;
  /** Emits a TodoWrite-style live checklist. */
  todo: boolean;
};

export type AgentManifest = {
  id: string;
  label: string;
  ingress: AgentIngress;
  interactions: AgentInteractions;
  /** Optional raw→canonical tool-name overrides for THIS engine, when its
   *  names don't already normalize through `toolDescribe`'s alias folding.
   *  Most engines need none — Claude/Codex/Gemini largely converge on
   *  Read/Edit/Bash/Grep once case + separators are stripped. */
  toolAliases?: Record<string, string>;
};

const NO_INTERACTIONS: AgentInteractions = {
  reasoning: false,
  toolCalls: false,
  questions: false,
  questionSets: false,
  plan: false,
  permission: false,
  todo: false,
};

const FULL_INTERACTIONS: AgentInteractions = {
  reasoning: true,
  toolCalls: true,
  questions: true,
  questionSets: true,
  plan: true,
  permission: true,
  todo: true,
};

/** The compiled-in agents. Capability flags reflect what each engine's
 *  adapter actually maps today — flip a flag ON only when its adapter lands. */
export const AGENT_MANIFESTS: Record<string, AgentManifest> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    ingress: "stream-json",
    // Claude Code is the reference protocol: thinking blocks, tool_use cards,
    // AskUserQuestion (sets + multiSelect), ExitPlanMode, can_use_tool
    // permission control, and TodoWrite all map cleanly.
    interactions: FULL_INTERACTIONS,
  },
  codex: {
    id: "codex",
    label: "Codex",
    ingress: "json-events",
    // Codex emits agent_message/agent_reasoning + exec_command + patch_apply +
    // exec_approval_request. No multi-question primitive; single approval is a
    // permission round-trip. (Adapter pending protocol-research wave.)
    interactions: {
      ...FULL_INTERACTIONS,
      questionSets: false,
      plan: true,
    },
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    ingress: "acp",
    // Gemini speaks ACP (`--experimental-acp`) or stream-json: thoughts, tool
    // calls + confirmations, plan. (Adapter pending protocol-research wave.)
    interactions: {
      ...FULL_INTERACTIONS,
      questionSets: false,
    },
  },
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    ingress: "acp",
    interactions: {
      ...FULL_INTERACTIONS,
      questionSets: false,
    },
  },
  kimi: {
    id: "kimi",
    label: "Kimi",
    ingress: "pty",
    // No structured stream wired yet — terminal-only until an adapter exists.
    interactions: NO_INTERACTIONS,
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    ingress: "json-events",
    interactions: {
      ...FULL_INTERACTIONS,
      questionSets: false,
      permission: true,
    },
  },
};

/** Fallback manifest for an agent we have no compiled entry for (e.g. one
 *  declared only in `~/.aura/agents.toml`). Renders the universal events
 *  (text / tool_call / result) and claims no rich interaction until an
 *  adapter proves it can drive one. */
export function genericManifest(id: string, label?: string): AgentManifest {
  return {
    id,
    label: label ?? id,
    ingress: "pty",
    interactions: NO_INTERACTIONS,
  };
}

/** Resolve the manifest for an agent id, falling back to a generic one so an
 *  unknown agent never throws — it just renders with conservative coverage. */
export function manifestFor(agentId: string, label?: string): AgentManifest {
  return AGENT_MANIFESTS[agentId] ?? genericManifest(agentId, label);
}

/** Whether an agent can render the rich structured chat at all (vs raw PTY).
 *  Used by the surface to decide if a "Chat / Terminal" view toggle is even
 *  meaningful for this engine. */
export function supportsStructuredChat(agentId: string): boolean {
  const m = manifestFor(agentId);
  return m.ingress !== "pty" && m.interactions.toolCalls;
}
