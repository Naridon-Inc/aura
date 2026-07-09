// Live "what's the agent doing right now" label for the workspace /
// session rows — the Warp-style activity ticker. Two sources, in
// preference order:
//
//   1. The agent's NATIVE window title (OSC 0/2), captured by the vte
//      parser in cmd_agent_pty.rs and delivered as `title`. This is the
//      agent's own status string — the same signal Warp reads to
//      auto-title a row — and works for any CLI that sets a title, even
//      without our plugin installed.
//   2. The OSC 777 hook stream (agentEventStore `last`). The plugin
//      fires `tool_complete` on every PostToolUse with `tool_name` +
//      `tool_input`, so the latest event tells us the most recent step.
//      We map that to a short phrase ("Editing RightRail.tsx", "Running
//      tsc", "Reading api.ts") — the guaranteed fallback when the agent
//      sets no title.
//
// Both are out-of-band from the TUI redraw, so no alt-screen scraping.

import type { CliAgentEvent } from "./api";

/** Basename of a path, for compact file labels. */
function base(p: string): string {
  const clean = p.replace(/[/\\]+$/, "");
  const i = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return i >= 0 ? clean.slice(i + 1) : clean;
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/**
 * A short present-tense activity phrase for the latest agent event, or
 * `null` when there's nothing meaningful to show (caller falls back to a
 * generic "running"). Intentionally terse so it fits a sidebar row.
 */
export function agentActivityLabel(last: CliAgentEvent | null): string | null {
  if (!last) return null;

  const tool = typeof last.tool_name === "string" ? last.tool_name : "";
  if (!tool) {
    // Between tools (or right after the prompt) we only know it's busy.
    return last.event === "prompt_submit" ? "Working…" : null;
  }

  const input = (last.tool_input ?? {}) as Record<string, unknown>;
  const file = typeof input.file_path === "string" ? base(input.file_path) : "";
  const cmd = typeof input.command === "string" ? input.command : "";
  const pattern =
    typeof input.pattern === "string"
      ? input.pattern
      : typeof input.query === "string"
        ? input.query
        : "";

  switch (tool) {
    case "Bash":
      return cmd ? `Running ${truncate(cmd, 30)}` : "Running a command";
    case "Read":
      return file ? `Reading ${file}` : "Reading a file";
    case "Edit":
    case "MultiEdit":
    case "Write":
      return file ? `Editing ${file}` : "Editing a file";
    case "NotebookEdit":
      return file ? `Editing ${file}` : "Editing a notebook";
    case "Grep":
    case "Glob":
      return pattern ? `Searching ${truncate(pattern, 26)}` : "Searching code";
    case "Task":
      return "Running a subagent";
    case "WebFetch":
    case "WebSearch":
      return "Searching the web";
    case "TodoWrite":
      return "Planning tasks";
    default:
      // MCP tools arrive as `mcp__server__tool` — show the tool leaf.
      if (tool.startsWith("mcp__")) {
        const leaf = tool.split("__").slice(-1)[0] ?? tool;
        return truncate(leaf.replace(/_/g, " "), 28);
      }
      return truncate(tool, 28);
  }
}

/**
 * Clean up a raw OSC window title for display in a row. Strips a leading
 * status glyph some CLIs prepend (e.g. "✳ ", "● ") and collapses
 * whitespace. Returns null for an empty/whitespace title.
 */
export function normalizeAgentTitle(title: string | null): string | null {
  if (!title) return null;
  const cleaned = title
    .replace(/\s+/g, " ")
    .trim()
    // Drop a leading non-word decoration glyph + space ("✳ ", "● ", "▸ ").
    .replace(/^[^\p{L}\p{N}/~.]+\s*/u, "")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The single live-activity string for a session, preferring the agent's
 * own native title over our hook-derived phrase. Returns null when
 * neither source has anything — the caller falls back to a generic
 * "running" verb.
 */
export function liveActivityText(
  title: string | null,
  last: CliAgentEvent | null,
): string | null {
  return normalizeAgentTitle(title) ?? agentActivityLabel(last);
}
