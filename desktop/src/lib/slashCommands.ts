// Static catalog of slash commands. Each entry maps to an MCP tool, an
// in-app UI action, an aura-cli verb, or a Claude Code-native slash
// (the kind a user would type into the Claude Code REPL — these only
// have meaning inside a PTY-mode agent tab and are routed there).
//
// Kept in lib/ rather than baked into the Composer so the keyboard
// palette (⌘K) and a future help surface can share the same catalog.

export type SlashCommand = {
  name: string;
  description: string;
  /**
   *  - "mcp"        → dispatch through aura-vcs MCP via the daemon.
   *  - "mcp-server" → dispatch through an external MCP server registered
   *                   under ~/.aura/mcp/ (Atlassian, Linear, …). Target
   *                   is "<server>:<tool>"; App.tsx routes to
   *                   `api.mcpToolInvoke`.
   *  - "ui"         → in-app action handled by App.tsx.
   *  - "aura-cli"   → shell out to `aura <verb>` and surface in OutputDialog.
   *  - "agent-pty"  → write the literal slash-line into the active
   *                   agent's PTY (Claude Code's /clear, /memory, etc.).
   *                   The dispatcher auto-spawns a PTY-mode tab if one
   *                   isn't already open.
   *  - "prompt"     → expand a saved prompt body into the Composer
   *                   textarea. `target` is the saved-prompt id; the
   *                   Composer reads the body from the SavedPrompt
   *                   surfaced via `expansion`.
   */
  kind: "mcp" | "mcp-server" | "ui" | "aura-cli" | "agent-pty" | "prompt";
  /** Action target — MCP tool id, UI action id, aura-cli verb (with
   *  optional sub-args), the literal slash text to inject, or the
   *  saved-prompt id. */
  target: string;
  /** Optional agent gate. If set, only show this command when the
   *  user is currently focused on (or about to send to) that agent.
   *  e.g. "claude" for Claude Code-native slashes. */
  agent?: string;
  /** For `kind === "prompt"`: the body to insert verbatim when picked.
   *  Carried on the entry so the Composer doesn't re-fetch on apply. */
  expansion?: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  // ─── Aura semantic engine ─────────────────────────────────────────
  // MCP-routed verbs. The daemon owns the actual implementation; the
  // dispatcher picks dialog vs. CLI passthrough per-tool.
  { name: "/plan", description: "Plan work before agents edit", kind: "ui", target: "plan_builder" },
  { name: "/prove", description: "Verify a requirement in the code", kind: "ui", target: "prove" },
  { name: "/compare", description: "Compare parallel copies side-by-side", kind: "ui", target: "compare_worktrees" },
  { name: "/impacts", description: "Show cross-branch impact alerts", kind: "mcp", target: "aura_live_impacts" },
  { name: "/prs", description: "Browse pull requests in this repo", kind: "ui", target: "open_prs_sidebar" },
  { name: "/inbox", description: "Open the PR inbox (Graphite-style triage)", kind: "ui", target: "open_inbox" },
  { name: "/pr", description: "Open a specific PR by number (/pr 123)", kind: "ui", target: "open_pr_by_number" },
  { name: "/review", description: "AI semantic PR review", kind: "mcp", target: "aura_pr_review" },
  { name: "/snapshot", description: "Snapshot the project (safety branch)", kind: "mcp", target: "aura_snapshot" },
  { name: "/rewind", description: "Surgically revert a function", kind: "mcp", target: "aura_rewind" },
  { name: "/log", description: "Log intent before committing", kind: "mcp", target: "aura_log_intent" },
  { name: "/memory", description: "Read or write episodic memory", kind: "mcp", target: "aura_memory_read" },
  { name: "/doctor", description: "Diagnose repo health", kind: "mcp", target: "aura_doctor" },
  { name: "/handover", description: "Compress context for agent handoff", kind: "mcp", target: "aura_handover" },
  { name: "/status", description: "Aura project status", kind: "mcp", target: "aura_status" },

  // ─── Aura CLI (shell-out) ─────────────────────────────────────────
  // Verbs that don't have first-class MCP coverage in the desktop UI yet
  // — surface them by calling the CLI and rendering output in the dialog.
  { name: "/ask", description: "Ask Aura about the codebase", kind: "aura-cli", target: "ask" },
  { name: "/audit", description: "Show the working tree audit trail", kind: "aura-cli", target: "audit" },
  { name: "/explain", description: "Explain a recent semantic change", kind: "aura-cli", target: "explain" },
  { name: "/usage", description: "Token + cost usage summary", kind: "aura-cli", target: "usage" },
  { name: "/visualize", description: "Render a dependency / impact graph", kind: "aura-cli", target: "visualize" },
  { name: "/intents", description: "Recent logged intents", kind: "aura-cli", target: "intents" },
  { name: "/recall", description: "Recall an earlier session by query", kind: "aura-cli", target: "recall" },
  { name: "/history", description: "Show file history", kind: "aura-cli", target: "history" },
  { name: "/trace", description: "Trace a goal across branches", kind: "aura-cli", target: "goal-trace" },
  { name: "/whoami", description: "Show signed-in identity", kind: "aura-cli", target: "whoami" },
  { name: "/team", description: "List team members + status", kind: "aura-cli", target: "team" },
  { name: "/know", description: "Search team knowledge base", kind: "ui", target: "knowledge" },
  { name: "/remote", description: "Pair a phone over LAN to drive this session", kind: "ui", target: "remote" },
  { name: "/inspect", description: "Review whether a commit matched the task", kind: "ui", target: "intent_inspector" },
  { name: "/replay", description: "Open the commit audit trail", kind: "ui", target: "provenance_replay" },
  { name: "/zones", description: "List active zone claims", kind: "aura-cli", target: "zones list" },
  { name: "/sentinel", description: "Inspect Sentinel agent presence", kind: "aura-cli", target: "sentinel agents" },
  { name: "/config", description: "Open Aura config", kind: "aura-cli", target: "config show" },
  { name: "/orchestrate", description: "Multi-agent orchestration status", kind: "aura-cli", target: "orchestrate status" },
  { name: "/pr-review", description: "Full semantic PR review (CLI)", kind: "aura-cli", target: "pr-review --base main" },
  { name: "/webhooks", description: "List webhook subscriptions", kind: "aura-cli", target: "webhooks list" },
  { name: "/agent-card", description: "Show this agent's identity card", kind: "aura-cli", target: "agent-card show" },
  { name: "/keys", description: "Manage signing keys", kind: "aura-cli", target: "keys list" },
  { name: "/policy", description: "Show active policies", kind: "aura-cli", target: "policy show" },
  { name: "/live", description: "Live-sync status", kind: "aura-cli", target: "live status" },

  // ─── Claude Code-native slashes ───────────────────────────────────
  // These only make sense inside an interactive Claude Code REPL.
  // Picking one auto-spawns a PTY-mode tab (or focuses an existing
  // one) and writes the literal slash-line into it.
  { name: "/clear", description: "Clear the Claude conversation in this tab", kind: "ui", target: "claude_clear", agent: "claude" },
  { name: "/resume", description: "Resume a previous Claude Code session", kind: "ui", target: "claude_resume", agent: "claude" },
  { name: "/compact", description: "Compact Claude's context window", kind: "agent-pty", target: "/compact", agent: "claude" },
  { name: "/agents", description: "Open Claude Code's agents picker", kind: "agent-pty", target: "/agents", agent: "claude" },
  { name: "/mcp", description: "Show Claude Code's MCP server list", kind: "agent-pty", target: "/mcp", agent: "claude" },
  { name: "/init", description: "Run Claude Code's project init", kind: "agent-pty", target: "/init", agent: "claude" },
  { name: "/add-dir", description: "Add a directory to Claude's allow-list", kind: "agent-pty", target: "/add-dir", agent: "claude" },
  { name: "/permissions", description: "Open Claude's permissions panel", kind: "agent-pty", target: "/permissions", agent: "claude" },
  { name: "/help", description: "Claude Code's built-in help", kind: "agent-pty", target: "/help", agent: "claude" },
  { name: "/login", description: "Sign in to Claude Code", kind: "agent-pty", target: "/login", agent: "claude" },
  { name: "/vim", description: "Toggle vim keybindings in Claude Code", kind: "agent-pty", target: "/vim", agent: "claude" },
  { name: "/model", description: "Switch the active Claude model", kind: "agent-pty", target: "/model", agent: "claude" },
  { name: "/cost", description: "Show Claude Code's cost summary", kind: "agent-pty", target: "/cost", agent: "claude" },

  // ─── Local UI actions ─────────────────────────────────────────────
  { name: "/terminal", description: "Toggle the terminal pane", kind: "ui", target: "toggle_terminal" },
  { name: "/clear-composer", description: "Clear the composer", kind: "ui", target: "clear_composer" },
];

/** Lookup a single slash command by exact name (e.g. "/plan"). */
export function findSlash(name: string): SlashCommand | null {
  const k = name.toLowerCase();
  return SLASH_COMMANDS.find((c) => c.name === k) ?? null;
}

/**
 * Filter against a "/foo" query — returns ranked list, optionally
 * narrowed to commands available for the current agent. Commands with
 * no `agent` gate are always included; commands gated to a specific
 * agent only appear when that agent is the active one (or no agent is
 * active yet, in which case we show them so the user can discover).
 */
export function filterSlash(query: string, activeAgent?: string): SlashCommand[] {
  return filterSlashWithExtras(query, activeAgent, []);
}

/** Variant that mixes in dynamic entries (e.g. saved prompts surfaced
 *  by the Composer). Caller is responsible for fetching/filtering the
 *  extras; we just merge + re-rank them with the static catalogue. */
export function filterSlashWithExtras(
  query: string,
  activeAgent: string | undefined,
  extras: SlashCommand[],
): SlashCommand[] {
  const q = query.toLowerCase().trim();
  if (!q.startsWith("/")) return [];
  const needle = q.slice(1);
  const all = [...SLASH_COMMANDS, ...extras];
  const pool = all.filter((c) => {
    if (!c.agent) return true;
    if (!activeAgent) return true;
    return c.agent === activeAgent;
  });
  if (!needle) return pool;
  return pool.filter(
    (c) =>
      c.name.toLowerCase().slice(1).startsWith(needle) ||
      c.description.toLowerCase().includes(needle),
  );
}
