//! ACP adapter — maps the blocks the ACP chat path emits (`acp_update`,
//! `acp_session`, `diagnostic`) into the engine-agnostic model.
//!
//! Two outputs, because ACP carries two kinds of thing:
//!   • transcript events — prose, thoughts, tool calls, plans, images, usage —
//!     returned by `normalizeAcpBlock` for the one renderer;
//!   • session state — the agent's own models, modes, config options, slash
//!     commands, title and context window — folded by `acpSessionState` for the
//!     composer. State updates never draw a transcript row.
//!
//! Agents stream prose as many small chunks. Consecutive chunks of one lane
//! (assistant text, user text, thought) share an id and carry `delta`, so the
//! reducer accretes them into one block; anything else in between (a tool
//! call, a plan, an image) closes the run.

import type { StreamEvent } from "../../api";
import type { NormalizedEvent, ToolContent, ToolKind } from "../events";
import { asObj } from "./describe";

type Base = {
  id: string;
  sessionId: string;
  ts: number;
  source: "user" | "agent";
};

/** The open chunk run, so a stream of chunks folds into one block. */
export type AcpRuns = {
  open: string | null;
  current: string;
  counter: Map<string, number>;
};

export function createAcpRuns(): AcpRuns {
  return { open: null, current: "", counter: new Map() };
}

/** Updates that change session state and draw nothing in the transcript. */
const STATE_UPDATES = new Set([
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
]);

const TOOL_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

function chunkId(runs: AcpRuns, turn: string, lane: string): string {
  const key = `${turn}:${lane}`;
  if (runs.open === key) return runs.current;
  const n = (runs.counter.get(key) ?? 0) + 1;
  runs.counter.set(key, n);
  runs.open = key;
  runs.current = `${turn}:acp-${lane}:${n}`;
  return runs.current;
}

/** A chunk's content as prose, when it reads as prose. Links and embedded
 *  resources become a markdown link so the reader sees what was attached. */
function chunkText(content: Record<string, unknown>): string | null {
  if (content.type === "text") return String(content.text ?? "");
  if (content.type === "resource_link") {
    const uri = String(content.uri ?? "");
    return `[${String(content.name ?? content.title ?? uri)}](${uri})`;
  }
  if (content.type === "resource") {
    const r = asObj(content.resource);
    const uri = String(r.uri ?? "");
    return typeof r.text === "string" && !uri ? r.text : `\`${uri}\``;
  }
  return null;
}

function toolStatus(status: unknown) {
  return status === "completed"
    ? ("completed" as const)
    : status === "failed"
      ? ("error" as const)
      : status === "pending"
        ? ("pending" as const)
        : ("running" as const);
}

function toolContent(raw: unknown): ToolContent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    const c = asObj(p);
    if (c.type === "diff")
      return {
        type: "diff",
        path: String(c.path ?? ""),
        oldText: typeof c.oldText === "string" ? c.oldText : undefined,
        newText: String(c.newText ?? ""),
      } as ToolContent;
    const inner = asObj(c.content);
    return {
      type: "content",
      text:
        inner.type === "text" ? String(inner.text ?? "") : JSON.stringify(p),
    } as ToolContent;
  });
}

function toolCall(
  u: Record<string, unknown>,
  base: Base,
  turn: string,
): NormalizedEvent {
  const callId = `${turn}:acp-tool:${String(u.toolCallId ?? "")}`;
  const status = toolStatus(u.status);
  const parts = toolContent(u.content);
  return {
    ...base,
    id: callId,
    kind: "tool_call",
    callId,
    toolName: String(u.title ?? "tool"),
    title: u.title ? String(u.title) : "",
    // An update that omits `kind` must not repaint the card as "other"; the
    // reducer keeps the first real kind.
    toolKind: TOOL_KINDS.has(String(u.kind)) ? (u.kind as ToolKind) : "other",
    input: asObj(u.rawInput),
    status,
    partial: status === "pending" || status === "running",
    content: parts.length ? parts : undefined,
    output:
      u.rawOutput != null
        ? typeof u.rawOutput === "string"
          ? u.rawOutput
          : JSON.stringify(u.rawOutput)
        : undefined,
    locations: Array.isArray(u.locations)
      ? u.locations.map((l) => {
          const o = asObj(l);
          return {
            path: String(o.path ?? ""),
            line: typeof o.line === "number" ? o.line : undefined,
          };
        })
      : undefined,
  };
}

/** One `session/update` → transcript events. */
function normalizeUpdate(
  update: unknown,
  base: Base,
  turn: string,
  runs: AcpRuns,
): NormalizedEvent[] {
  const u = asObj(update);
  const type = String(u.sessionUpdate ?? "");
  if (STATE_UPDATES.has(type)) return [];
  const content = asObj(u.content);
  if (
    type === "agent_message_chunk" ||
    type === "user_message_chunk" ||
    type === "agent_thought_chunk"
  ) {
    const text = chunkText(content);
    if (text != null) {
      const lane =
        type === "agent_thought_chunk"
          ? "thought"
          : type === "user_message_chunk"
            ? "user"
            : "text";
      const id = chunkId(runs, turn, lane);
      if (lane === "thought")
        return [{ ...base, id, kind: "reasoning", text, delta: text }];
      return [
        {
          ...base,
          id,
          source: lane === "user" ? "user" : "agent",
          kind: "text",
          role: lane === "user" ? "user" : "assistant",
          text,
          delta: text,
        },
      ];
    }
  }
  if (type === "usage_update") {
    const used = Number(u.used);
    if (!Number.isFinite(used) || used < 0) return [];
    // The live context, not a per-call sum: one id per turn, latest wins.
    return [
      {
        ...base,
        id: `${turn}:acp-usage`,
        kind: "usage",
        contextTokens: used,
        outputTokens: 0,
      },
    ];
  }
  runs.open = null;
  if (type === "tool_call" || type === "tool_call_update")
    return [toolCall(u, base, turn)];
  if (type === "plan")
    return [
      {
        ...base,
        id: `${turn}:plan`,
        kind: "plan",
        awaitingApproval: false,
        entries: Array.isArray(u.entries)
          ? u.entries.map((p) => {
              const e = asObj(p);
              return {
                content: String(e.content ?? ""),
                status:
                  e.status === "completed"
                    ? ("completed" as const)
                    : e.status === "in_progress"
                      ? ("in_progress" as const)
                      : ("pending" as const),
              };
            })
          : [],
      },
    ];
  if (content.type === "image" && typeof content.data === "string")
    return [
      {
        ...base,
        kind: "image",
        role: type === "user_message_chunk" ? "user" : "assistant",
        data: content.data,
        mediaType: String(content.mimeType ?? "image/png"),
      },
    ];
  return [
    {
      ...base,
      kind: "raw",
      label: type.replace(/_/g, " ") || "Agent update",
      payload: u,
    },
  ];
}

/** True for the block types this adapter owns. */
export function isAcpBlock(type: unknown): boolean {
  return (
    type === "acp_update" || type === "acp_session" || type === "diagnostic"
  );
}

/** One ACP content block (as the chat path emits it) → transcript events. */
export function normalizeAcpBlock(
  block: Record<string, unknown>,
  base: Base,
  turn: string,
  runs: AcpRuns,
): NormalizedEvent[] {
  if (block.type === "acp_update")
    return normalizeUpdate(block.update, base, turn, runs);
  if (block.type === "acp_session") return [];
  runs.open = null;
  return [
    {
      ...base,
      kind: "raw",
      label: "Agent diagnostic",
      payload: { text: String(block.text ?? "") },
    },
  ];
}

// ── Session state ────────────────────────────────────────────────────────

export type AcpChoice = {
  value: string;
  name: string;
  description?: string;
  group?: string;
};

export type AcpConfigOption = {
  id: string;
  name: string;
  category?: string;
  /** `select` or `boolean`. */
  kind: string;
  current: unknown;
  choices: AcpChoice[];
};

export type AcpCommand = { name: string; description: string; hint?: string };

export type AcpSessionState = {
  sessionId: string;
  /** How the session opened: new, resumed or loaded. */
  how: string;
  options: AcpConfigOption[];
  modes: { current?: string; available: { id: string; name: string }[] };
  legacyModels: string[];
  legacyModel?: string;
  commands: AcpCommand[];
  title?: string;
  usage?: { used: number; size: number };
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function choice(raw: unknown, group?: string): AcpChoice | null {
  const c = asObj(raw);
  const value = str(c.value);
  if (!value) return null;
  return {
    value,
    name: str(c.name) ?? value,
    description: str(c.description),
    group: str(c.group) ?? group,
  };
}

/** A raw ACP `configOptions[]` entry (as `config_option_update` carries it). */
function wireOption(raw: unknown): AcpConfigOption | null {
  const o = asObj(raw);
  const id = str(o.id);
  if (!id) return null;
  const choices: AcpChoice[] = [];
  for (const entry of Array.isArray(o.options) ? o.options : []) {
    const e = asObj(entry);
    if (Array.isArray(e.options)) {
      for (const c of e.options) {
        const parsed = choice(c, str(e.name));
        if (parsed) choices.push(parsed);
      }
    } else {
      const parsed = choice(e);
      if (parsed) choices.push(parsed);
    }
  }
  return {
    id,
    name: str(o.name) ?? id,
    category: str(o.category),
    kind: str(o.type) ?? "select",
    current: o.currentValue ?? null,
    choices,
  };
}

/** The serialized `aura_acp::Session` option (`acp_session` block). */
function sessionOption(raw: unknown): AcpConfigOption | null {
  const o = asObj(raw);
  const id = str(o.id);
  if (!id) return null;
  return {
    id,
    name: str(o.name) ?? id,
    category: str(o.category),
    kind: str(o.kind) ?? "select",
    current: o.current ?? null,
    choices: (Array.isArray(o.choices) ? o.choices : [])
      .map((c) => choice(c))
      .filter((c): c is AcpChoice => c !== null),
  };
}

function fromSession(raw: unknown): AcpSessionState | null {
  const s = asObj(raw);
  const sessionId = str(s.id);
  if (!sessionId) return null;
  const modes = asObj(s.modes);
  return {
    sessionId,
    how: str(s.how) ?? "new",
    options: (Array.isArray(s.config) ? s.config : [])
      .map(sessionOption)
      .filter((o): o is AcpConfigOption => o !== null),
    modes: {
      current: str(modes.current),
      available: (Array.isArray(modes.available) ? modes.available : [])
        .map((m) =>
          Array.isArray(m) && typeof m[0] === "string"
            ? { id: m[0], name: typeof m[1] === "string" ? m[1] : m[0] }
            : null,
        )
        .filter((m): m is { id: string; name: string } => m !== null),
    },
    legacyModels: (Array.isArray(s.legacy_models) ? s.legacy_models : [])
      .filter((m): m is string => typeof m === "string"),
    legacyModel: str(s.legacy_current_model),
    commands: [],
  };
}

function applyUpdate(state: AcpSessionState, update: unknown): void {
  const u = asObj(update);
  switch (u.sessionUpdate) {
    case "available_commands_update":
      state.commands = (
        Array.isArray(u.availableCommands) ? u.availableCommands : []
      )
        .map((c): AcpCommand | null => {
          const o = asObj(c);
          const name = str(o.name);
          return name
            ? {
                name,
                description: String(o.description ?? ""),
                hint: str(asObj(o.input).hint),
              }
            : null;
        })
        .filter((c): c is AcpCommand => c !== null);
      break;
    case "current_mode_update": {
      const mode = str(u.currentModeId);
      if (!mode) break;
      state.modes = { ...state.modes, current: mode };
      state.options = state.options.map((o) =>
        o.category === "mode" ? { ...o, current: mode } : o,
      );
      break;
    }
    case "config_option_update":
      if (Array.isArray(u.configOptions))
        state.options = u.configOptions
          .map(wireOption)
          .filter((o): o is AcpConfigOption => o !== null);
      break;
    case "session_info_update":
      if (typeof u.title === "string") state.title = u.title || undefined;
      break;
    case "usage_update": {
      const used = Number(u.used),
        size = Number(u.size);
      if (Number.isFinite(used) && Number.isFinite(size))
        state.usage = { used, size };
      break;
    }
  }
}

/** Fold a chat's raw stream into the latest ACP session's state, or null
 *  when the chat never opened one. A newer `acp_session` (a reopened or
 *  fresh session) starts over. */
export function acpSessionState(
  events: readonly StreamEvent[],
): AcpSessionState | null {
  let state: AcpSessionState | null = null;
  for (const ev of events) {
    if (ev.kind !== "content_block") continue;
    const b = asObj(ev.payload);
    if (b.type === "acp_session") {
      state = fromSession(b.session) ?? state;
    } else if (b.type === "acp_update" && state) {
      applyUpdate(state, b.update);
    }
  }
  return state;
}

/** The option a category names (`model`, `mode`, `thought_level`), if any. */
export function acpOption(
  state: AcpSessionState | null,
  category: string,
): AcpConfigOption | undefined {
  return state?.options.find((o) => o.category === category || o.id === category);
}

/** The models this session offers, from its config option or the older list. */
export function acpModels(state: AcpSessionState | null): AcpChoice[] {
  const option = acpOption(state, "model");
  if (option) return option.choices;
  return (state?.legacyModels ?? []).map((m) => ({ value: m, name: m }));
}

/** The model the session is running now. */
export function acpCurrentModel(
  state: AcpSessionState | null,
): string | undefined {
  const current = acpOption(state, "model")?.current;
  return typeof current === "string" ? current : state?.legacyModel;
}
