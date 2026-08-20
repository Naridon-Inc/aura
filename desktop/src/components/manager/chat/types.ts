//! Shared contract for the native Aura chat rendering modules.
//!
//! `ManagerChatView` was a 4000-line monolith; the chat-rendering pieces
//! (tool cards, message bodies, empty state, status lines, the tool
//! description registry) live under `chat/` as focused modules. Every one
//! of them speaks these types, so the registry that *produces* a `ToolView`
//! and the card that *consumes* it can evolve independently.

/** Result of a server-side tool execution, keyed back to its `ToolUse`. */
export type ToolResult = { is_error: boolean; content: string };

/** Card status derived from whether a result has landed and its error flag. */
export type ToolStatus = "running" | "ok" | "error";

/** Visual prominence of a tool call.
 *  - "thinking" — context-gathering only (read/grep/glob/ls/fetch); renders
 *    as a single quiet line that disappears into the activity stream.
 *  - "action"   — mutates code, runs commands, dispatches subagents, or asks
 *    the user; renders as a proper card so the user notices it. */
export type ToolTier = "thinking" | "action";

/** Accent for an action card's status + glyph, mapped to design tokens by
 *  the card (never a raw hex). "neutral" is the default ink. */
export type ToolAccent = "neutral" | "accent" | "green" | "red" | "amber";

/** One step in a multi-step tool (e.g. TodoWrite) rendered as a status list. */
export type ToolStep = {
  label: string;
  status: "pending" | "in_progress" | "completed";
};

/** One unified description shape for every tool. The card renders these
 *  fields uniformly; per-brain naming differences (snake_case `read_file`
 *  vs PascalCase `Read`) are normalized inside the registry, never here. */
export type ToolView = {
  /** Short verb like "Reading" / "Editing" / "Running" / "Asking". */
  verb: string;
  tier: ToolTier;
  /** Smart object label — a basename, a pattern, a command. */
  subject?: string;
  /** Render `subject` in mono (commands, paths). */
  mono?: boolean;
  /** A dim mono secondary preview shown right of `subject` on the collapsed
   *  row — e.g. the shell command behind a human-described bash step, so a
   *  settled step reads "Ran · <description> · `the command`" like Conductor. */
  aux?: string;
  /** The full shell command behind a terminal tool. When set (with the "run"
   *  glyph) the expanded card renders a single terminal well — a `>`-prefixed
   *  prompt line carrying this command, then its output below — instead of a
   *  separate header chip + output box. Untruncated; the well scrolls. */
  command?: string;
  /** Brief result-side metric: "342 lines", "exit 0", "3 matches". */
  metric?: string;
  /** Inline body under the headline — question text, command description,
   *  subagent prompt. */
  body?: string;
  /** Hide the raw INPUT JSON pane when expanded — used for friendly-rendered
   *  aura subcommands where the human-readable subject+body are canonical. */
  hideRawInput?: boolean;
  /** Structured step list — when present the card renders a multi-step
   *  loader (status circle + label per row) instead of `body`. */
  steps?: ToolStep[];
  /** Optional glyph key for the card's leading icon. Maps to an inline SVG
   *  in the card's glyph table; falls back to a generic dot when absent. */
  glyph?: ToolGlyph;
  /** Accent for the status pip + glyph; defaults to "neutral". */
  accent?: ToolAccent;
  /** A unified-diff string (`@@`/`+`/`-` lines) for edit/write tools, so the
   *  card can render added/removed hunks instead of opaque JSON. */
  diff?: string;
  /** Structured ask-the-user question(s) + options, rendered as a compact
   *  options block instead of dumping the raw questions JSON. */
  ask?: AskView;
  /** Humanized key→value parameter rows for tools without a richer body, so
   *  no tool ever leaks raw INPUT JSON. */
  fields?: ToolField[];
  /** A proposed plan (ExitPlanMode) as markdown — the expanded card renders it
   *  through the prose markdown engine in a calm plan block, never raw JSON. */
  planMarkdown?: string;
  /** Local filesystem path of an image the tool just read/opened
   *  (png/jpg/gif/webp/svg/…). When set, the card renders the actual image
   *  inline (via the Tauri asset protocol) instead of a bare "Reading foo.png"
   *  row — the brain runs on the same machine, so the path resolves directly
   *  off disk with no backend round-trip. */
  imagePath?: string;
};

/** One selectable answer for an ask-the-user tool. */
export type AskOption = { label: string; description?: string };

/** One question (with its options) inside an ask-the-user tool call. */
export type AskQuestion = {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: AskOption[];
};

/** All questions carried by a single ask-the-user tool call. */
export type AskView = { questions: AskQuestion[] };

/** A humanized parameter row: a labelled, plain-language input value. The
 *  card renders these instead of the raw INPUT JSON for any tool that lacks
 *  a richer body, so a tool call is never an opaque JSON wall. */
export type ToolField = { label: string; value: string };

/** Known glyph keys. The card owns the name→SVG table; the registry only
 *  names the glyph so the two stay decoupled. */
export type ToolGlyph =
  | "read"
  | "search"
  | "glob"
  | "list"
  | "fetch"
  | "edit"
  | "write"
  | "run"
  | "dispatch"
  | "ask"
  | "task"
  | "page"
  | "review"
  | "plan"
  | "generic";

/** Per-turn token accounting surfaced to the chat header's context-fill
 *  meter. Best-effort: only set once a brain that reports usage finishes a
 *  turn. Mirrors the Rust `TokenUsage` / the API `BrainTokenUsage`. */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

/** What a turn cost in API mode, plus the key's running total. Null for
 *  subscription and CLI-wrapper brains, which aren't billed per token —
 *  there's no honest dollar figure to show, so the UI shows none. */
export type TurnSpend = {
  /** USD this one response cost. */
  costUsd: number;
  /** USD this key has spent since it was added, across EVERY project. */
  spendUsd: number;
  /** Unix seconds the key was first seen — the "since" date. */
  spendSince: number;
  /** True when a figure was priced off a model-family rate rather than a
   *  published one; the UI prefixes it with `~`. */
  estimated: boolean;
};

/** What the brain accumulates mid-turn. Text blocks are streaming assistant
 *  prose; tool blocks are one Anthropic `tool_use` each, with the eventual
 *  `tool_result` tacked on once dispatch returns; reasoning blocks carry the
 *  model's extended-thinking stream (rendered as a collapsible disclosure).
 *  Rendered chronologically by `block_idx` — the order the model emitted
 *  them. */
export type StreamBlock =
  | { kind: "text"; block_idx: number; text: string }
  | { kind: "reasoning"; block_idx: number; text: string }
  | {
      kind: "tool";
      block_idx: number;
      tool_use_id: string;
      name: string;
      input: unknown;
      result?: ToolResult;
      /** Epoch ms the tool_use first arrived. The live "Running … 1m 08s" row
       *  anchors its timer here instead of its own mount time, so a view
       *  remount mid-command (a workspace switch) resumes the real elapsed
       *  rather than restarting at 0. Absent on blocks rebuilt from a settled
       *  transcript — those are done and show no timer. */
      started_at?: number;
    };
