import type { NormalizedEvent, ToolCallEvent } from "../src/lib/agentProtocol/events";

export const envelope = { sessionId: "fixture-session", source: "agent" as const, ts: 1, turnId: "turn-1" };
export function tool(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return { ...envelope, kind: "tool_call", id: "tool-1", callId: "tool-1", toolKind: "execute",
    toolName: "Bash", title: "Run checks", status: "running", input: { command: "bun test", description: "Run checks" }, ...overrides };
}

/** Every normalized event kind and every terminal tool outcome in one session. */
export const coverageEvents: NormalizedEvent[] = [
  { ...envelope, kind: "session_init", id: "init", model: "custom/reasoning-model", provider: "Fixture", tools: ["Bash", "Read", "Edit"] },
  { ...envelope, kind: "text", id: "user", source: "user", role: "user", text: "Check every chat state, including failures and unfamiliar content." },
  { ...envelope, kind: "reasoning", id: "reason", text: "I will check the stream, tool results, and session boundaries." },
  { ...envelope, kind: "text", id: "assistant", role: "assistant", text: "## Coverage review\n\nThe transcript keeps **every outcome** visible.\n\n| State | Expected |\n|---|---|\n| Empty result | Completed |\n| Cancelled | Cancelled |\n| Missing result | No result |" },
  tool({ id: "ok", callId: "ok", status: "completed", output: "" }),
  tool({ id: "error", callId: "error", status: "error", output: "Connection timed out", isError: true }),
  tool({ id: "cancel", callId: "cancel", status: "cancelled" }),
  tool({ id: "missing", callId: "missing", status: "unknown" }),
  { ...envelope, kind: "usage", id: "usage", contextTokens: 1200, outputTokens: 240 },
  { ...envelope, kind: "status", id: "retry", state: "retry", attempt: 2, message: "Retrying connection" },
  { ...envelope, kind: "question_set", id: "question", requestId: "question", partial: false, questions: [{ id: "q1", prompt: "Which systems?", multiSelect: true, freeText: true, options: [{ optionId: "a", label: "CLI agents" }, { optionId: "b", label: "Local and hosted models" }] }], resolution: { text: "CLI agents and custom endpoints", isError: false } },
  { ...envelope, kind: "plan", id: "plan", entries: [{ content: "Verify supported transports", status: "completed" }, { content: "Inspect unfamiliar payloads", status: "in_progress" }], awaitingApproval: false },
  { ...envelope, kind: "todo", id: "todo", todos: [{ content: "Preserve completed output", status: "completed" }, { content: "Test interruption", status: "in_progress" }] },
  { ...envelope, kind: "permission_request", id: "permission", requestId: "permission", title: "Run the deployment command?", toolName: "Bash", input: { command: "deploy" }, options: [], partial: false },
  { ...envelope, kind: "raw", id: "audio", label: "Audio attachment", payload: { type: "audio", mimeType: "audio/wav", resource: "fixture.wav" } },
  { ...envelope, kind: "image", id: "image", role: "assistant", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6X8sAAAAASUVORK5CYII=" },
  { ...envelope, kind: "error", id: "error-row", message: "Provider unavailable. Partial output is retained." },
  { ...envelope, kind: "result", id: "result", subtype: "cancelled", text: "The session was stopped before the remaining work finished.", durationMs: 4200, totalTokens: 1440 },
];
