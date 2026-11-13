// A conversation written out as Markdown: to hand to another conversation as
// an attachment, or to copy from a chat tab.

import type { ChatTurn, PersistedToolCall } from "./api";

const SPEAKER: Record<ChatTurn["role"], string> = {
  user: "User",
  manager: "Assistant",
  system: "System",
};

/** The attachment's file name, as the chip and the composer show it. */
export function transcriptFileName(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|\n\r]+/g, " ").replace(/\s+/g, " ").trim();
  return `Transcript of ${clean || "chat"}.md`;
}

/** Every turn with text, under a heading naming who said it. `null` when the
 *  conversation has no messages at all. */
export function chatTranscriptMarkdown(title: string, turns: ChatTurn[]): string | null {
  const said = turns.filter((t) => t.text.trim());
  if (!said.length) return null;
  const body = said.map((t) => `## ${SPEAKER[t.role] ?? t.role}\n\n${t.text.trim()}`).join("\n\n");
  return `# ${title.trim() || "Chat"}\n\n${body}\n`;
}

// ── The transcript a chat tab copies ───────────────────────────────────────
// "Copy concise transcript" (⌘⌥C) and "Copy full transcript" on a chat tab.
// Same headings as the attachment above, without the title: what you paste
// is the conversation. A concise copy keeps what was said and counts the tool
// calls; a complete one writes each call with what it was given and what came
// back, shortened so one long read doesn't bury the rest.

/** How much of the conversation a copied transcript carries. */
export type TranscriptMode = "concise" | "complete";

/** A concise copy cuts any one message here. */
const LONGEST_MESSAGE = 10_000;
/** The input fields that say what a call was about, in the order asked. */
const SUMMARY_FIELDS = ["command", "file_path", "path", "pattern", "url", "description"];
/** A summary this short, on one line, sits beside the tool's name. */
const INLINE_SUMMARY = 80;
/** A longer summary or a result keeps this many lines… */
const KEPT_LINES = 10;
/** …and this many characters. */
const KEPT_CHARS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What a call was about: its command, path, pattern, address or
 *  description, else its whole input. `null` for a call given nothing. */
function callSummary(input: unknown): string | null {
  if (!isRecord(input) || Object.keys(input).length === 0) return null;
  for (const field of SUMMARY_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\\"/g, '"');
  }
  return JSON.stringify(input);
}

/** The first lines of a long text, saying how much was left out. */
function shorten(text: string): string {
  const lines = text.split("\n");
  if (lines.length > KEPT_LINES) {
    const head = lines.slice(0, KEPT_LINES).join("\n");
    return `${head.length > KEPT_CHARS ? head.slice(0, KEPT_CHARS) : head}\n…\n(${lines.length - KEPT_LINES} more lines)`;
  }
  return text.length > KEPT_CHARS ? `${text.slice(0, KEPT_CHARS)}\n…\n(truncated)` : text;
}

function indented(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/** One call, as a complete transcript writes it: the tool and what it was
 *  given, then what came back under a ↳. A call cancelled before its result
 *  landed has no ↳ line. */
function writtenCall(call: PersistedToolCall): string {
  const lines: string[] = [];
  const summary = callSummary(call.input);
  if (summary === null) lines.push(`    ${call.name}`);
  else if (!summary.includes("\n") && summary.length <= INLINE_SUMMARY)
    lines.push(`    ${call.name}: ${summary}`);
  else lines.push(`    ${call.name}:`, indented(shorten(summary), "        "));
  if (call.result) {
    const [first, ...rest] = shorten(call.result.content).split("\n");
    lines.push([`    ↳ ${first}`, ...rest.map((line) => `      ${line}`)].join("\n"));
  }
  return lines.join("\n");
}

/** What one turn contributes, or `null` when it said nothing. Calls come
 *  ahead of the reply, the order the chat shows them in. */
function turnBody(turn: ChatTurn, mode: TranscriptMode): string | null {
  const text = turn.text.trim();
  const said = mode === "concise" && text.length > LONGEST_MESSAGE ? text.slice(0, LONGEST_MESSAGE) : text;
  if (turn.role === "user") return said || null;
  if (turn.role === "system") return said ? `[System: ${said}]` : null;
  const calls = turn.tool_calls ?? [];
  const parts: string[] = [];
  if (calls.length && mode === "concise")
    parts.push(calls.length === 1 ? "[1 tool call elided]" : `[${calls.length} tool calls elided]`);
  if (calls.length && mode === "complete") parts.push(...calls.map(writtenCall));
  if (said) parts.push(said);
  return parts.length ? parts.join("\n\n") : null;
}

/** The conversation as a chat tab copies it: each run of turns from one side
 *  under `## User` or `## Assistant`. `null` when nothing was said. */
export function chatTranscriptText(turns: ChatTurn[], mode: TranscriptMode): string | null {
  const groups: { speaker: string; bodies: string[] }[] = [];
  for (const turn of turns) {
    const body = turnBody(turn, mode);
    if (body === null) continue;
    const speaker = turn.role === "user" ? "User" : "Assistant";
    const last = groups[groups.length - 1];
    if (last?.speaker === speaker) last.bodies.push(body);
    else groups.push({ speaker, bodies: [body] });
  }
  if (!groups.length) return null;
  return groups.map((g) => `## ${g.speaker}\n\n${g.bodies.join("\n\n")}`).join("\n\n");
}

/** The toast after a copy: which transcript, of which chat, the chat's name
 *  cut to twenty characters. */
export function copiedTranscriptMessage(mode: TranscriptMode, title: string): string {
  const name = title.trim() || "chat";
  const short = name.length > 20 ? `${name.slice(0, 20).trimEnd()}...` : name;
  return `Copied ${mode} transcript of "${short}"`;
}
