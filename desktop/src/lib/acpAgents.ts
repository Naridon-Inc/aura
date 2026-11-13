// The agents in the ACP registry, as this computer has them.
//
// Every value comes from the desktop (`acp_agents.rs`): which agents the
// registry lists, which ones run here and from where, which ones Aura can
// install, and how each signed in last. Installing puts an agent in Aura's
// own folder (`~/.aura/acp/agents`); an agent already on this computer's
// PATH belongs to the person and is never installed over or removed.

import { invoke } from "@tauri-apps/api/core";

import { letterMark } from "./monogram";
import { relativeAgeFromIso } from "./relativeTime";

export type AcpAgentState = "ready" | "installable" | "unavailable";

/** Where a ready agent runs from. */
export type AcpLaunchSource = { kind: "installed"; version: string } | { kind: "path" } | { kind: "uvx" };

export type AcpAgentRow = {
  /** The registry's id, e.g. `gemini` or `claude-acp`. */
  id: string;
  /** The Aura agent it stands for, e.g. `claude` for `claude-acp`. */
  aura_id: string;
  name: string;
  /** The registry's current version. */
  version: string;
  description: string | null;
  website: string | null;
  license: string | null;
  icon: string | null;
  state: AcpAgentState;
  source: AcpLaunchSource | null;
  program: string | null;
  install_method: "binary" | "npm" | null;
  /** Installable only as a download its maker published no checksum for. */
  unverified: boolean;
  reason: string | null;
  /** The sign-in method Aura remembered from the agent's last sign-in. */
  signed_in_with: string | null;
};

/** One of the agent's own saved chats (`session/list`). */
export type AcpListedSession = {
  session_id: string;
  cwd: string;
  title: string | null;
  updated_at: string | null;
};

export const acpAgentsApi = {
  /** `refresh` fetches the live registry first; the cached copy answers otherwise. */
  list: (refresh = false) => invoke<AcpAgentRow[]>("acp_agents_list", { refresh }),
  install: (id: string, allowUnverified = false) =>
    invoke<AcpAgentRow>("acp_agent_install", { id, allowUnverified }),
  uninstall: (id: string) => invoke<void>("acp_agent_uninstall", { id }),
  sessions: (id: string, repoRoot: string) => invoke<AcpListedSession[]>("acp_agent_sessions", { id, repoRoot }),
  forgetSignIn: (id: string) => invoke<void>("acp_agent_forget_sign_in", { id }),
};

/** Aura installed this copy, so Aura may update or remove it. */
export function installedByAura(row: AcpAgentRow): row is AcpAgentRow & { source: { kind: "installed"; version: string } } {
  return row.state === "ready" && row.source?.kind === "installed";
}

/** The version Aura installed, when the registry has moved past it. */
export function staleVersion(row: AcpAgentRow): string | null {
  return installedByAura(row) && row.source.version !== row.version ? row.source.version : null;
}

/** Ready agents first, then by name, the way the desktop sorts them. */
export function sortAgents(rows: AcpAgentRow[]): AcpAgentRow[] {
  const key = (r: AcpAgentRow) => (r.state === "ready" ? 0 : 1);
  return [...rows].sort((a, b) => key(a) - key(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** The list with one agent's new standing in place of its old one. */
export function withRow(rows: AcpAgentRow[], next: AcpAgentRow): AcpAgentRow[] {
  const found = rows.some((r) => r.id === next.id);
  return sortAgents(found ? rows.map((r) => (r.id === next.id ? next : r)) : [...rows, next]);
}

export type AgentGroups = {
  /** Runs here now. */
  here: AcpAgentRow[];
  /** Aura can install it. */
  available: AcpAgentRow[];
  /** No build for this computer. */
  elsewhere: AcpAgentRow[];
};

export function groupAgents(rows: AcpAgentRow[]): AgentGroups {
  return {
    here: rows.filter((r) => r.state === "ready"),
    available: rows.filter((r) => r.state === "installable"),
    elsewhere: rows.filter((r) => r.state === "unavailable"),
  };
}

/** One line on where an agent stands on this computer. */
export function standingLine(row: AcpAgentRow): string {
  if (row.state === "ready") {
    const stale = staleVersion(row);
    if (stale) return `Version ${stale} is installed. Version ${row.version} is out.`;
    switch (row.source?.kind) {
      case "installed":
        return `Version ${row.version}, installed by Aura.`;
      case "path":
        return "Aura uses the copy already on this computer.";
      case "uvx":
        return "Runs through uvx, which fetches it when a chat starts.";
      default:
        return "Ready on this computer.";
    }
  }
  if (row.state === "installable") {
    if (row.unverified) return `Version ${row.version}. Its maker publishes no checksum, so Aura can’t check the download.`;
    return row.install_method === "npm"
      ? `Version ${row.version}. Aura installs it with npm into its own folder.`
      : `Version ${row.version}. Aura checks the download before it runs.`;
  }
  return row.reason ?? "There is no build of it for this computer.";
}

/** A remembered sign-in method id, in words: `oauth-personal` → `Oauth personal`. */
export function methodLabel(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}

/** The sign-in card's line. Agents sign in from the chat, the first time. */
export function signInLine(row: AcpAgentRow): string {
  return row.signed_in_with
    ? `Signed in with ${methodLabel(row.signed_in_with)}. Aura signs in the same way next time.`
    : `Not signed in yet. ${row.name} asks the first time you chat, and Aura remembers how you signed in.`;
}

export function sessionTitle(s: AcpListedSession): string {
  return s.title?.trim() || "Untitled chat";
}

/** When the chat last changed, else the folder it ran in. */
export function sessionLine(s: AcpListedSession, now = Date.now()): string {
  const age = relativeAgeFromIso(s.updated_at, { now });
  return age ? `Last active ${age}` : s.cwd;
}

/** The chat tab that picks an earlier chat back up. */
export function resumeTab(row: AcpAgentRow, session: AcpListedSession, repoRoot: string, tabId: string) {
  return {
    sessionId: tabId,
    agentId: row.aura_id,
    agentLabel: row.name,
    agentMonogram: letterMark(row.name),
    repoRoot,
    mode: "stream" as const,
    resumeSessionId: session.session_id,
  };
}
