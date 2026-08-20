// Transcript data model — the pure (no-JSX) layer that folds the raw
// StreamEvent stream into a flat conversation of messages, the way the
// reference session view (entire.io) reads: an avatar-gutter chat of user
// prompts and agent responses, with the agent's tool calls as compact
// intermediate-step rows between them.
//
// We still lean on `turn_id` — the loader mints one per user prompt and
// stamps the work that follows — but only to attribute each prompt its tool
// "call" count for the meta line ("· 3 calls"); the render itself is a flat
// stream, not a turn tree.
//
// HONESTY RULE: every item is a real event from the session file. Nothing is
// synthesised. Where a datum is absent (e.g. a prompt's timestamp on an older
// loader build that didn't capture it), the UI omits it rather than guessing.

import type { StreamEvent } from "../../../lib/api";
import { stripSteeringDirective } from "../../../lib/steeringDirective";
import { relativeAge } from "../../../lib/relativeTime";
import { compactNumber } from "../../../lib/compactNumber";
import { formatCost } from "../../../lib/money";
import { basename } from "../../../lib/paths";
import { clockTime } from "../../../lib/clockTime";
import { sentenceCase } from "../../../lib/textCase";

// ── tool classification ──────────────────────────────────────────────

export type ToolKind = "edit" | "bash" | "read" | "other";

/** Title-case a raw tool slug for the "Other" bucket — "web_fetch" → "Web
 *  fetch", "mcp__aura-vcs__aura_status" → "aura status". */
export function humanizeTool(name: string): string {
  let s = name;
  const mcp = s.match(/^mcp__[^_]+(?:__|_)(.+)$/);
  if (mcp) s = mcp[1];
  s = s.replace(/^aura[_-]?/i, "aura ");
  s = s.replace(/[_-]+/g, " ").trim();
  if (!s) return name;
  return sentenceCase(s);
}

/** Render template for a tool row — distinct from `kind` (the filter bucket).
 *  `kind` answers "which checkbox hides this"; `shape` answers "which
 *  human-readable card draws it" (a diff for an edit, a terminal for a shell
 *  run, a result list for a web search, …). Many shapes collapse into the
 *  `other` filter bucket. */
export type ToolShape =
  | "edit"
  | "write"
  | "read"
  | "bash"
  | "web_fetch"
  | "web_search"
  | "search"
  | "todo"
  | "generic";

export type ToolView = {
  kind: ToolKind;
  shape: ToolShape;
  verb: string;
  subject: string;
  mono: boolean;
};

export function describeTool(name: string, input: unknown): ToolView {
  const n = (name ?? "").toLowerCase();
  const obj = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const str = (k: string): string =>
    typeof obj[k] === "string" ? (obj[k] as string) : "";

  // edits → diff; writes → added-content. Both filter as "edit".
  if (
    n === "edit" ||
    n === "multiedit" ||
    n === "applypatch" ||
    n === "apply_patch"
  ) {
    const path = str("file_path") || str("path");
    return { kind: "edit", shape: "edit", verb: "Edited", subject: basename(path), mono: true };
  }
  if (n === "write" || n === "notebookedit") {
    const path = str("file_path") || str("path") || str("notebook_path");
    return { kind: "edit", shape: "write", verb: "Wrote", subject: basename(path), mono: true };
  }
  // reads → file + line range.
  if (n === "read" || n === "readfile" || n === "read_file") {
    const path = str("file_path") || str("path");
    return { kind: "read", shape: "read", verb: "Read", subject: basename(path), mono: true };
  }
  // shell → terminal + exit status.
  if (
    n === "bash" ||
    n === "bashstreaming" ||
    n === "bashoutput" ||
    n === "shell" ||
    n === "run"
  ) {
    const cmd = str("command") || str("cmd");
    const firstLine = cmd.split("\n")[0] ?? "";
    return { kind: "bash", shape: "bash", verb: "Ran", subject: firstLine.trim(), mono: true };
  }
  // web fetch → domain + page summary.
  if (n === "webfetch" || n === "web_fetch" || n === "fetch") {
    const url = str("url") || str("uri");
    return { kind: "other", shape: "web_fetch", verb: "Fetched", subject: urlHost(url), mono: false };
  }
  // web search → query + result list.
  if (n === "websearch" || n === "web_search") {
    return { kind: "other", shape: "web_search", verb: "Searched", subject: str("query") || str("q"), mono: false };
  }
  // code search → pattern + matches.
  if (n === "grep" || n === "ripgrep" || n === "search") {
    return { kind: "other", shape: "search", verb: "Searched code", subject: str("pattern") || str("query"), mono: true };
  }
  if (n === "glob" || n === "findfiles") {
    return { kind: "other", shape: "search", verb: "Globbed", subject: str("pattern") || str("glob"), mono: true };
  }
  // todo / plan → checklist.
  if (n === "todowrite" || n === "todo_write") {
    const todos = Array.isArray(obj.todos) ? (obj.todos as unknown[]).length : 0;
    return {
      kind: "other",
      shape: "todo",
      verb: "Updated plan",
      subject: todos ? `${todos} item${todos === 1 ? "" : "s"}` : "",
      mono: false,
    };
  }
  // delegated subagent.
  if (n === "task" || n === "agent") {
    return { kind: "other", shape: "generic", verb: "Delegated", subject: str("description") || str("subagent_type"), mono: false };
  }
  // everything else — humanized name + best-effort subject (covers MCP tools).
  // For a path-valued subject show the basename (the absolute path is still in
  // the expanded raw input) so generic/MCP rows read as cleanly as the
  // edit/read/write rows instead of printing a full "/Users/…/src/main.rs".
  const pathLike = str("path") || str("file_path") || str("notebook_path");
  const subject =
    str("pattern") ||
    str("query") ||
    str("url") ||
    str("description") ||
    (pathLike ? basename(pathLike) : "") ||
    "";
  return { kind: "other", shape: "generic", verb: humanizeTool(name), subject, mono: !!pathLike };
}

/** Host of a URL, sans leading `www.` — "https://kilo.ai/x" → "kilo.ai".
 *  Falls back to a best-effort strip when the URL won't parse. */
export function urlHost(u: string): string {
  const s = (u ?? "").trim();
  if (!s) return "";
  try {
    return new URL(s).host.replace(/^www\./, "");
  } catch {
    return s.replace(/^https?:\/\//, "").split(/[/?#]/)[0] ?? s;
  }
}

export type EditLines = { removed: string[]; added: string[] };

/** Split an Edit's old→new (or a MultiEdit's edits, or a Write's content)
 *  into removed/added line arrays for a compact before/after diff. Returns
 *  null when there's nothing structured to show. */
export function editLines(name: string, input: unknown): EditLines | null {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof obj[k] === "string" ? (obj[k] as string) : "");
  const n = (name ?? "").toLowerCase();

  if (n === "write" || n === "notebookedit") {
    const content = s("content") || s("contents") || s("new_source");
    return content ? { removed: [], added: content.split("\n") } : null;
  }
  if (n === "multiedit") {
    const edits = Array.isArray(obj.edits) ? (obj.edits as unknown[]) : [];
    const removed: string[] = [];
    const added: string[] = [];
    for (const e of edits) {
      const eo = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
      const o = typeof eo.old_string === "string" ? eo.old_string : "";
      const a = typeof eo.new_string === "string" ? eo.new_string : "";
      if (o) removed.push(...o.split("\n"));
      if (a) added.push(...a.split("\n"));
    }
    return removed.length || added.length ? { removed, added } : null;
  }
  const oldS = s("old_string");
  const newS = s("new_string");
  if (!oldS && !newS) return null;
  return {
    removed: oldS ? oldS.split("\n") : [],
    added: newS ? newS.split("\n") : [],
  };
}

/** A Read's "lines 12–48" window from offset/limit, or "" when unbounded. */
export function readRange(input: unknown): string {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const off = typeof obj.offset === "number" ? obj.offset : undefined;
  const lim = typeof obj.limit === "number" ? obj.limit : undefined;
  if (off == null && lim == null) return "";
  const start = off ?? 1;
  if (lim == null) return `from line ${start}`;
  return `lines ${start}–${start + lim - 1}`;
}

export const KIND_LABEL: Record<ToolKind, string> = {
  edit: "File edit",
  bash: "Bash",
  read: "Read",
  other: "Tool",
};

/** Token CSS var per tool kind — used for the tool-card icon tint and the
 *  filter-rail kind dot. The palette is restrained and on-brand (no teal
 *  fills): edits read as "change" (green), shell runs as violet, reads stay
 *  neutral, and web/other carry the app's arctic-blue accent. */
export const KIND_COLOR: Record<ToolKind, string> = {
  edit: "var(--color-accent-green)",
  bash: "var(--color-violet)",
  read: "var(--color-text-3)",
  other: "var(--color-accent)",
};

// ── message model ────────────────────────────────────────────────────

export type ToolResult = { content: string; isError: boolean } | null;

export type Item =
  | { type: "prompt"; key: string; text: string; ts: number; calls: number }
  | { type: "response"; key: string; text: string; ts: number }
  | {
      type: "tool";
      key: string;
      name: string;
      view: ToolView;
      input: unknown;
      result: ToolResult;
    }
  | { type: "checkpoint"; key: string; file: string }
  | { type: "image"; key: string; data: string; media: string }
  | {
      type: "system";
      key: string;
      sub: "init" | "result" | "warning" | "error";
      text: string;
      tone: "muted" | "warn" | "err";
    };

export type FilterKey =
  | "prompt"
  | "response"
  | "edit"
  | "bash"
  | "read"
  | "other"
  | "checkpoint";

/** Fold the raw event stream into a flat list of chat items: pair each
 *  tool_result into its tool_use, merge directly-adjacent assistant_text into
 *  one response block, attribute each prompt its tool-call count (via
 *  turn_id), and translate protocol events into inline indicators. */
export function foldItems(events: StreamEvent[]): Item[] {
  const resultById = new Map<string, { content: string; isError: boolean }>();
  const callsByTurn = new Map<string, number>();
  // The loader only stamps a `ts` on the user_prompt that opens a turn (and on
  // aura_snapshot side-effects). The agent's assistant_text carries none, so we
  // anchor a response to its turn's start time — the same turn the prompt began.
  // This is the turn's real timestamp, not a guess: every event sharing a
  // turn_id happened at-or-after that prompt.
  const tsByTurn = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "tool_result") {
      resultById.set(e.tool_use_id, { content: e.content, isError: e.is_error });
    }
    if (e.kind === "tool_use") {
      callsByTurn.set(e.turn_id, (callsByTurn.get(e.turn_id) ?? 0) + 1);
    }
    if ((e.kind === "user_prompt" || e.kind === "aura_snapshot") && e.ts) {
      // Prefer the earliest stamp seen for a turn (the opening prompt).
      const prev = tsByTurn.get(e.turn_id);
      if (prev == null || e.ts < prev) tsByTurn.set(e.turn_id, e.ts);
    }
  }

  const items: Item[] = [];
  let i = 0;
  for (const e of events) {
    const key = `${e.kind}:${i++}`;
    switch (e.kind) {
      case "user_prompt": {
        // Strip the mode steering directive ([AUTO/PLAN/ASK MODE — …]) and pipe
        // marker — model-facing wiring, never human-facing in the transcript.
        const cleaned = stripSteeringDirective(e.text);
        const t = cleaned.trim();
        if (!t) break;
        items.push({
          type: "prompt",
          key,
          text: cleaned,
          ts: e.ts ?? 0,
          calls: callsByTurn.get(e.turn_id) ?? 0,
        });
        break;
      }
      case "assistant_text": {
        const t = e.text.trim();
        if (!t) break;
        const prev = items[items.length - 1];
        if (prev && prev.type === "response") {
          prev.text = `${prev.text}${e.text}`;
        } else {
          items.push({ type: "response", key, text: e.text, ts: tsByTurn.get(e.turn_id) ?? 0 });
        }
        break;
      }
      case "tool_use":
        items.push({
          type: "tool",
          key,
          name: e.name,
          view: describeTool(e.name, e.input),
          input: e.input,
          result: resultById.get(e.id) ?? null,
        });
        break;
      case "tool_result":
        break; // folded into its tool_use
      case "aura_snapshot":
        items.push({ type: "checkpoint", key, file: e.file_path });
        break;
      case "image":
        items.push({ type: "image", key, data: e.data, media: e.media_type });
        break;
      case "system_init": {
        const tools = e.tools?.length ? `${e.tools.length} tools` : "";
        const model = e.model ?? "session start";
        items.push({
          type: "system",
          key,
          sub: "init",
          text: [model, tools].filter(Boolean).join(" · "),
          tone: "muted",
        });
        break;
      }
      case "result": {
        const bits: string[] = [];
        bits.push(e.success ? "Completed" : "Ended");
        if (Number.isFinite(e.duration_ms)) {
          bits.push(`${(e.duration_ms / 1000).toFixed(1)}s`);
        }
        if (e.total_tokens != null) bits.push(`${compactNumber(e.total_tokens)} tok`);
        if (e.cost_usd != null) bits.push(formatCost(e.cost_usd));
        items.push({
          type: "system",
          key,
          sub: "result",
          text: bits.join(" · "),
          tone: e.success ? "muted" : "err",
        });
        break;
      }
      case "aura_warning":
        items.push({ type: "system", key, sub: "warning", text: e.message, tone: "warn" });
        break;
      case "raw_error":
        items.push({ type: "system", key, sub: "error", text: e.message, tone: "err" });
        break;
    }
  }
  return items;
}

/** Compact "5d ago" style age, extending formatRelativeAge past hours into
 *  days/weeks (the reference shows day-scale ages). Returns "" for a missing
 *  timestamp so the caller can omit it rather than print a fake time. */
export function relAge(ts: number, now: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAge(ts, { now });
}

/** Absolute wall-clock for a message — "2:34 PM" — from a captured timestamp.
 *  Per-message clock reads better than a relative age inside a transcript,
 *  where every line of a days-old session would otherwise say the same "5d
 *  ago". Empty for a missing timestamp so the caller omits it. */
export function fmtClock(ts: number): string {
  if (!ts || ts <= 0) return "";
  try {
    return clockTime(ts);
  } catch {
    return "";
  }
}

/** A continuation / handover summary message — the dense "This session is being
 *  continued from a previous conversation…" block the harness injects when a
 *  conversation is compacted, or an `aura handover` payload. These carry the
 *  prior session's full state (often with embedded code) and are the substrate
 *  for agent-to-agent handover, so we keep them but render them as a contextual,
 *  collapsible card instead of a raw-markdown wall. Detection is deliberately
 *  conservative — signature openers, or a long body with the summary scaffold —
 *  so an ordinary long prompt isn't mistaken for one. */
export function isHandoverSummary(text: string): boolean {
  const t = (text ?? "").trimStart();
  if (!t) return false;
  if (/^This session is being continued from a previous conversation/i.test(t)) return true;
  if (/^The (?:conversation|session) (?:below|summary)/i.test(t)) return true;
  if (/^<\s*handover\b/i.test(t) || /^<\s*aura[_-]?handover\b/i.test(t)) return true;
  // Structured summary scaffold (Claude Code compaction) — needs the heading
  // plus real bulk so a short message that merely mentions "Summary:" is safe.
  if (t.length > 1800 && /\n\s*(?:Analysis|Summary):/i.test(t) && /\n\s*\d+\.\s/.test(t)) {
    return true;
  }
  return false;
}

/** A one-line gist for a collapsed handover card — the first non-empty,
 *  non-heading line, trimmed. */
export function summaryGist(text: string): string {
  const lines = (text ?? "").split("\n");
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (/^#{1,6}\s/.test(l) || /^```/.test(l)) continue;
    return l.length > 160 ? `${l.slice(0, 160)}…` : l;
  }
  return "Continued from a previous session.";
}

/** Split the flat item list into turn blocks: a block opens at each prompt
 *  (anything before the first prompt is the leading block) and keeps its
 *  original prompt → tools → response order. Reversing the BLOCKS — not the raw
 *  items — flips the transcript to newest-first without scrambling within-turn
 *  causality (a tool's result still follows its call). */
export function groupTurns(items: Item[]): Item[][] {
  const groups: Item[][] = [];
  let cur: Item[] | null = null;
  for (const it of items) {
    if (it.type === "prompt" || cur == null) {
      cur = [];
      groups.push(cur);
    }
    cur.push(it);
  }
  return groups;
}

/** Which FilterKey an item belongs to — null for items the filters never hide
 *  (system indicators are governed by the "show hidden" toggle instead). */
export function filterKeyOf(it: Item): FilterKey | null {
  switch (it.type) {
    case "prompt":
      return "prompt";
    case "response":
      return "response";
    case "checkpoint":
      return "checkpoint";
    case "tool":
      return it.view.kind;
    default:
      return null;
  }
}

export type Counts = Record<FilterKey, number> & { system: number };

export function countItems(items: Item[]): Counts {
  const c: Counts = {
    prompt: 0,
    response: 0,
    edit: 0,
    bash: 0,
    read: 0,
    other: 0,
    checkpoint: 0,
    system: 0,
  };
  for (const it of items) {
    if (it.type === "system") c.system += 1;
    const k = filterKeyOf(it);
    if (k) c[k] += 1;
  }
  return c;
}
