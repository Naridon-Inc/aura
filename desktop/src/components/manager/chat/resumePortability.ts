//! "Where can I resume this Aura chat?" — the portability read behind the
//! "Resume this chat elsewhere" sheet.
//!
//! The fear this answers: a chat held in Aura's own store
//! (`~/.aura/manager-sessions/`) is invisible to `claude --resume`,
//! `gemini`, `codex resume`, … so if Aura ever isn't in front of you, the
//! conversation feels stranded. The backend already writes a chat into any
//! agent's native resume store (`chat_export_for_agent`); this just decides
//! *which* agents to offer and how to frame it:
//!
//!   • single-agent chat  → move it cleanly into that one agent's CLI.
//!   • multi-agent chat   → replicate the whole transcript into EVERY agent
//!                          it used (each reopens it as an imported
//!                          transcript, not that vendor's private session
//!                          internals — the sheet says so).
//!   • can't-receive      → an agent with no on-disk resume format we can
//!                          author (or an uninstalled CLI) is shown, but
//!                          marked so the user knows why it's not offered.
//!
//! Pure + deterministic; the only input is the persisted chat plus the
//! installed-agent list. No backend call here.

import type { AgentDescriptor, ChatTurn } from "../../../lib/api";
import { summarizeSessionBrains } from "./sessionBrains";
import { brainAgentId, humanizeBrainId } from "./StatusLine";

/** True when "resume this chat in <agent>" genuinely writes the agent's own
 *  on-disk session store (vs a primer-seeded handoff). Mirrors the per-agent
 *  tier the backend's `chat_export_for_agent` chooses — claude / gemini /
 *  codex have resumable session stores we author in their native format;
 *  every other agent has no store we can write. Kept in sync with the Rust
 *  match in `cmd_chat_export.rs::build_agent_export`. */
export function agentSupportsResume(agentId: string): boolean {
  const id = agentId.trim().toLowerCase();
  return id === "claude" || id === "gemini" || id === "codex";
}

/** One agent this chat can be carried into. */
export type ResumeAgentTarget = {
  /** Canonical registry slug (`claude` / `gemini` / `codex` / …). */
  agentId: string;
  /** Human label (`Claude`, `Gemini`, …). */
  label: string;
  /** Assistant turns this agent produced in the chat (0 for a target the
   *  chat never used — only set for `used`). */
  turns: number;
  /** The agent's CLI is installed on PATH. */
  available: boolean;
  /** We can write a real resumable session for it AND it's installed — the
   *  only state in which a "Save" actually lands somewhere. */
  canResume: boolean;
};

/** The chat's resume story. */
export type ResumePortability = {
  /** `"empty"` — no assistant turn recorded a brain (an older or brand-new
   *  thread); `"single"` — exactly one agent ran it; `"multi"` — two or more
   *  distinct agents ran it. */
  kind: "empty" | "single" | "multi";
  /** Distinct agents that actually produced turns, in first-seen order. */
  used: ResumeAgentTarget[];
  /** Every installed agent whose native store we can author — the universe of
   *  valid "send a copy to" targets, independent of what the chat used. Used
   *  for the empty / can't-receive fallbacks and "also send elsewhere". */
  resumableInstalled: ResumeAgentTarget[];
};

/** Fold a chat + the installed-agent list into its portability read. */
export function computeResumePortability(
  chat: ChatTurn[],
  agents: AgentDescriptor[],
): ResumePortability {
  const byId = new Map<string, AgentDescriptor>();
  for (const a of agents) byId.set(a.id.toLowerCase(), a);

  const target = (agentId: string, turns: number): ResumeAgentTarget => {
    const desc = byId.get(agentId.toLowerCase());
    const available = desc?.available ?? false;
    return {
      agentId,
      label: desc?.label ?? humanizeBrainId(agentId),
      turns,
      available,
      canResume: available && agentSupportsResume(agentId),
    };
  };

  // The universe of valid copy targets: installed CLIs we can author a native
  // resumable store for. First-seen registry order is fine — claude / gemini /
  // codex are listed in that order by the registry.
  const resumableInstalled = agents
    .filter((a) => a.available && agentSupportsResume(a.id))
    .map((a) => target(a.id, 0));

  const summary = summarizeSessionBrains(chat);
  if (!summary) {
    return { kind: "empty", used: [], resumableInstalled };
  }

  // Collapse raw brain ids → canonical agent slug, preserving first-seen order
  // and summing turns: `anthropic` and `cli:claude_code` both fold into
  // `claude`, so a chat that only ever ran Claude reads as one agent, not two.
  const order: string[] = [];
  const turnsByAgent = new Map<string, number>();
  for (const use of summary.brains) {
    const slug = brainAgentId(use.brain);
    if (!slug) continue;
    if (!turnsByAgent.has(slug)) order.push(slug);
    turnsByAgent.set(slug, (turnsByAgent.get(slug) ?? 0) + use.turns);
  }

  const used = order.map((slug) => target(slug, turnsByAgent.get(slug) ?? 0));
  const kind: ResumePortability["kind"] =
    used.length === 0 ? "empty" : used.length === 1 ? "single" : "multi";

  return { kind, used, resumableInstalled };
}
