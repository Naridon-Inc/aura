// Shared read-outs for an agent's live event stream (the `StreamEvent`
// feed from agentStreamStore). Moved out of WorkspaceProgressPopover so the
// workspace-tile hover card and the per-worktree hover card
// (WorktreeHoverCard) describe "what is this agent doing right now" the exact
// same way — one implementation, two surfaces.
//
// Pure, real-data-only: `summarizeEvents` reads the actual event stream, the
// `relAge*` helpers humanize a seconds-ago delta. Nothing is invented — an
// empty stream yields `null` and the caller renders nothing.

import type { StreamEvent } from "./api";
import { relativeAgeFromDelta } from "./relativeTime";

/** The most recent meaningful signal in an agent's stream, condensed to one
 *  line: a running tool, a streaming assistant reply, or the last prompt.
 *  Returns null when the stream carries nothing worth showing. */
export function summarizeEvents(events: StreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "assistant_text" && e.text) {
      return condense(e.text);
    }
    if (e.kind === "tool_use") {
      return `→ ${e.name}${toolHint(e.name, e.input)}`;
    }
    if (e.kind === "user_prompt" && e.text) {
      return `you: ${condense(e.text)}`;
    }
  }
  return null;
}

function toolHint(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  if (name === "Bash" && typeof o.command === "string") return ` ${truncate(o.command, 40)}`;
  if (
    (name === "Read" || name === "Edit" || name === "Write") &&
    typeof o.file_path === "string"
  ) {
    const tail = o.file_path.split("/").slice(-1)[0];
    return ` ${tail}`;
  }
  return "";
}

function condense(s: string): string {
  return truncate(s.replace(/\s+/g, " ").trim(), 96);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** "5s ago" / "3m ago" / "2h ago" / "4d ago" from a seconds-ago delta. */
export function relAge(s: number): string {
  return relativeAgeFromDelta(s);
}
