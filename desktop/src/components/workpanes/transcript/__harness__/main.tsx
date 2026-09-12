// The shared transcript, rendered on its own with a fixture stream.
//
// Dev-server only — reached at /transcript-harness.html, never bundled.
// The scene is the real TranscriptView from aura-shared, the same component
// the desktop's SessionTranscript wraps and the web console renders — so a
// capture of this page is the ground truth both apps must match.

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import { TranscriptView } from "@shared/ui/transcript/TranscriptView";
import type { StreamEvent } from "@shared/streamEvent";
import "../../../../styles.css";

const now = Date.now();

/** A believable session: prompt → plan → edits → verify → result. Every kind
 *  the rail folds is present, so the filters panel shows real counts. */
const EVENTS: StreamEvent[] = [
  {
    kind: "system_init",
    session_id: "d3f39198",
    model: "claude-fable-5",
    tools: ["Bash", "Edit", "Read", "Write"],
    turn_id: "t1",
  },
  {
    kind: "user_prompt",
    text: "the session detail page shows raw JSON for tool calls — fold them into readable rows like the desktop app does",
    turn_id: "t1",
    ts: now - 42 * 60_000,
  },
  {
    kind: "assistant_text",
    text: "Looking at `SessionDetailPage.tsx` — the transcript pane renders each message body verbatim. The desktop folds tool calls into typed rows in `TranscriptMessage.tsx`; I'll reuse that fold here.",
    turn_id: "t1",
  },
  {
    kind: "tool_use",
    id: "tu1",
    name: "Read",
    input: { file_path: "aura-console/src/surfaces/sessions/SessionDetailPage.tsx" },
    turn_id: "t1",
  },
  {
    kind: "tool_result",
    tool_use_id: "tu1",
    content: "// SessionDetailPage — one cloud session read as a story…\n(612 lines)",
    is_error: false,
    turn_id: "t1",
  },
  {
    kind: "tool_use",
    id: "tu2",
    name: "Edit",
    input: {
      file_path: "aura-console/src/surfaces/sessions/SessionDetailPage.tsx",
      old_string: "<MessageRow msg={m} />",
      new_string: "<TranscriptView events={events} agentId={agent} />",
    },
    turn_id: "t1",
  },
  {
    kind: "tool_result",
    tool_use_id: "tu2",
    content: "Edited SessionDetailPage.tsx",
    is_error: false,
    turn_id: "t1",
  },
  {
    kind: "tool_use",
    id: "tu3",
    name: "Bash",
    input: { command: "cd aura-console && bun run build", description: "Typecheck + build the console" },
    turn_id: "t1",
  },
  {
    kind: "tool_result",
    tool_use_id: "tu3",
    content: "✓ built in 3.42s",
    is_error: false,
    turn_id: "t1",
  },
  {
    kind: "aura_snapshot",
    file_path: "aura-console/src/surfaces/sessions/SessionDetailPage.tsx",
    ts: now - 40 * 60_000,
    turn_id: "t1",
  },
  {
    kind: "assistant_text",
    text: "Done. The console's transcript pane now renders the desktop's `TranscriptView` — same fold, same filters rail, same sticky prompt headers.\n\n- tool calls read as typed rows, not JSON\n- the FILTERS rail counts what the stream actually holds\n- prompts pin to the top while their turn scrolls",
    turn_id: "t1",
  },
  {
    kind: "usage",
    context_tokens: 48_213,
    output_tokens: 2_140,
    message_id: "m1",
    turn_id: "t1",
  },
  {
    kind: "result",
    success: true,
    duration_ms: 187_000,
    cost_usd: 0.84,
    total_tokens: 50_353,
    message: null,
    turn_id: "t1",
  },
];

ReactDOM.createRoot(document.getElementById("transcript-harness")!).render(
  <StrictMode>
    <div
      data-scene="transcript"
      className="dark h-screen w-screen overflow-hidden bg-bg-content"
    >
      <TranscriptView events={EVENTS} agentId="claude" theme="dark" />
    </div>
  </StrictMode>,
);
