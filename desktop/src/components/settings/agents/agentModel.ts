// The plain facts behind Settings → Agents: which order the tabs come in,
// what each agent is called on its tab, which config file it reads, and how
// a sign-in answer reads as one line. Kept apart from the components so the
// wording can be tested without rendering anything.

import type { AgentDescriptor, AgentsTomlEntry, api } from "../../../lib/api";

export type ClaudeStatus = Awaited<ReturnType<typeof api.claudeAuthStatus>>;
export type CodexStatus = Awaited<ReturnType<typeof api.codexAuthStatus>>;

/** The four agents the page leads with, in the order it shows them. Every
 *  other agent on the machine follows in the order Aura registers them. */
const LEADING = ["claude", "codex", "cursor", "opencode"];

/** Tab names. The registry calls Cursor's CLI "Cursor Agent"; on a tab
 *  strip of agents the second word says nothing. */
const TAB_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

export function orderAgents(registry: AgentDescriptor[]): AgentDescriptor[] {
  const rank = (id: string) => {
    const at = LEADING.indexOf(id);
    return at === -1 ? LEADING.length : at;
  };
  return registry
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => rank(a.agent.id) - rank(b.agent.id) || a.index - b.index)
    .map(({ agent }) => agent);
}

export function tabLabel(agent: AgentDescriptor): string {
  return TAB_LABELS[agent.id] ?? agent.label;
}

export interface AgentConfigFile {
  title: string;
  /** Relative to the home folder. */
  relativePath: string;
}

/** The config files the agents themselves read — the same three the
 *  cross-machine sync carries. */
const CONFIG_FILES: Record<string, AgentConfigFile> = {
  claude: { title: "Claude settings", relativePath: ".claude/settings.json" },
  codex: { title: "Codex config", relativePath: ".codex/config.toml" },
  gemini: { title: "Gemini settings", relativePath: ".gemini/settings.json" },
};

export const AGENTS_TOML: AgentConfigFile = {
  title: "Agent definition",
  relativePath: ".aura/agents.toml",
};

export function configFileFor(agentId: string): AgentConfigFile | null {
  return CONFIG_FILES[agentId] ?? null;
}

/** A `--version` that begins or ends by naming the tool names it a second
 *  time on a tab already called that: `claude --version` answers
 *  "2.1.220 (Claude Code)", `codex --version` answers "codex-cli 0.128.0". */
export function cleanVersion(agent: AgentDescriptor): string | null {
  const version = agent.version
    ?.replace(/\s*\(([^)]+)\)\s*$/, (match, inner: string) =>
      inner.trim().toLowerCase() === agent.label.toLowerCase() ? "" : match,
    )
    .replace(/^(\S+)\s+(?=\d)/, (match, first: string) =>
      first.toLowerCase().replace(/-cli$/, "") === agent.id.toLowerCase() ? "" : match,
    )
    .trim();
  return version || null;
}

/** What the tab's tooltip says: the binary, the id and what the CLI can do.
 *  Engine words, so they stay out of the page itself. */
export function agentDetail(agent: AgentDescriptor): string {
  const caps = [
    agent.capabilities.stream && "streams its output as it works",
    agent.capabilities.pty && "runs in a real terminal",
    agent.capabilities.resume && "can reopen a past session",
  ].filter(Boolean) as string[];
  return [
    agent.available
      ? `Aura runs: ${agent.bin}`
      : `Aura looks for “${agent.bin}” on this machine and doesn’t find it.`,
    `Known to Aura as: ${agent.id}`,
    caps.length > 0 ? `It ${caps.join(", ")}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function installedLine(agent: AgentDescriptor): string {
  if (!agent.available) return `Not installed. Aura looks for “${agent.bin}” and doesn’t find it.`;
  const version = cleanVersion(agent);
  return version ? `Installed · ${version}` : "Installed";
}

export function missingAgentsLine(count: number): string | null {
  if (count === 0) return null;
  const lead =
    count === 1
      ? "One of these isn’t on this machine yet."
      : `${count} of these aren’t on this machine yet.`;
  return `${lead} Nothing is broken. Install the tool the usual way, then look again and Aura will pick it up.`;
}

export function claudeStatusLine(status: ClaudeStatus | null, cliMissing: boolean): string {
  if (cliMissing) return "Claude Code isn’t installed on this machine.";
  if (!status) return "Checking sign-in…";
  if (!status.logged_in) return "Not signed in";
  const who = status.email ? `Signed in as ${status.email}` : "Signed in";
  const plan = status.subscription_type ? `${status.subscription_type} plan` : null;
  return [who, plan, status.org_name].filter(Boolean).join(" · ");
}

/** The method card a signed-in Claude Code account was made with. */
export function claudeMethod(status: ClaudeStatus | null): "cli" | "key" {
  const how = `${status?.auth_method ?? ""} ${status?.api_provider ?? ""}`.toLowerCase();
  return /console|api/.test(how) ? "key" : "cli";
}

export function codexStatusLine(status: CodexStatus | null): string {
  if (!status) return "Checking sign-in…";
  if (status.state === "logged_in") {
    return status.method ? `Signed in with ${status.method}` : "Signed in";
  }
  if (status.state === "missing" || status.state === "broken") {
    const saved = status.has_credentials ? " Your sign-in is saved and comes back once it runs." : "";
    return `${status.detail ?? "Codex can’t run on this machine."}${saved}`;
  }
  return "Not signed in";
}

export function codexMethod(status: CodexStatus | null): "chatgpt" | "key" {
  return /api/.test((status?.method ?? "").toLowerCase()) ? "key" : "chatgpt";
}

export function blankEntry(): AgentsTomlEntry {
  return {
    id: "",
    label: "",
    bin: "",
    args: [],
    supports_stream: false,
    supports_pty: true,
    supports_resume: false,
  };
}

export function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}
