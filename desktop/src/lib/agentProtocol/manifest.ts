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
    // Measured against the adapter, not the protocol. Codex's rollout JSONL
    // does carry `exec_approval_request` and a plan tool, and this entry used
    // to claim both — but `normalizeCodex` emits exactly seven kinds
    // (session_init, text, reasoning, tool_call, usage, result, error) and
    // none of them is a plan, a permission gate, a question or a checklist.
    // The flags are what the RENDERER may offer, so claiming an affordance the
    // adapter never produces is how you get a control with nothing behind it.
    // Turn one on in the same commit that teaches the adapter to emit it.
    interactions: {
      reasoning: true,
      toolCalls: true,
      todo: false,
      questions: false,
      questionSets: false,
      plan: false,
      permission: false,
    },
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    ingress: "acp",
    // Gemini speaks ACP (`--experimental-acp`) — thoughts, tool calls with
    // confirmations, a plan — and every one of those would map. But no ACP
    // normalizer is registered (`NORMALIZERS` has no "acp" entry), so
    // `normalizeStream` returns null for this id and a Gemini session renders
    // through the PTY block fallback. Nothing here can be surfaced until that
    // adapter lands, so nothing here is claimed.
    interactions: NO_INTERACTIONS,
  },
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    ingress: "acp",
    // Same as Gemini: ACP is declared, no ACP adapter is wired yet.
    interactions: NO_INTERACTIONS,
  },
  kimi: {
    id: "kimi",
    label: "Kimi",
    ingress: "json-events",
    // Kimi paints a TUI, but it also writes the real conversation to
    // `wire.jsonl`, and that file is what the adapter reads: prose, thinking,
    // tool calls with their results, a todo checklist, per-turn usage and the
    // turn result. This entry used to say `pty` + nothing, which was true
    // before the adapter landed and wrong after — it made `canNormalize`
    // answer false for an engine whose adapter is wired and tested, so any
    // caller trusting the manifest was told to fall back to raw terminal
    // bytes. Questions, plans and permission gates stay off because Kimi's
    // wire has no record of them.
    interactions: {
      reasoning: true,
      toolCalls: true,
      todo: true,
      questions: false,
      questionSets: false,
      plan: false,
      permission: false,
    },
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    ingress: "json-events",
    // Measured against a real `opencode run --format json`, which is the wire
    // the adapter parses: it emits text, reasoning, tool parts and a todowrite
    // checklist, and nothing else. Permissions and questions DO exist in
    // OpenCode — as `permission.v2.asked` / `question.v2.asked` on the server
    // bus that `opencode serve` publishes — but that is a different transport
    // we don't consume, so claiming them here would offer the user an
    // allow/deny affordance with nothing on the other end of it.
    interactions: {
      reasoning: true,
      toolCalls: true,
      todo: true,
      questions: false,
      questionSets: false,
      plan: false,
      permission: false,
    },
  },
  pi: {
    id: "pi",
    label: "Pi",
    ingress: "json-events",
    // Read off pi 0.83.0's own `AgentSessionEvent` union, which is what
    // `--mode json` forwards verbatim. Pi is the first engine after Claude
    // Code with a REAL token stream: `message_update` carries the provider's
    // `text_delta` / `thinking_delta` as they arrive, so both reasoning and
    // text type themselves into the transcript rather than landing whole.
    //
    // Tool calls are `tool_execution_start/update/end`, keyed by a real
    // `toolCallId`, with `isError` set by the tool throwing — which for pi's
    // bash means a non-zero exit, so a failed command cannot arrive looking
    // like a success.
    //
    // The rest are off because pi does not have them, not because the
    // adapter skipped them. There is no todo tool — the seven built-ins are
    // read, bash, edit, write, grep, find and ls — so a checklist would have
    // no source. And pi has no tool-approval gate at ALL headless: its
    // `RpcCommand` union under `--mode rpc` is prompt / steer / abort /
    // set_model / compact / bash and so on, with no approval round-trip
    // anywhere in it, and `--approve` is about trusting project-local config
    // files, not tool calls. Pi's answer to "what may this agent do" is
    // `--tools` at spawn time, which is a different and earlier decision.
    // Claiming a permission affordance here would draw an allow/deny prompt
    // with nothing on the other end of it.
    interactions: {
      reasoning: true,
      toolCalls: true,
      todo: false,
      questions: false,
      questionSets: false,
      plan: false,
      permission: false,
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
