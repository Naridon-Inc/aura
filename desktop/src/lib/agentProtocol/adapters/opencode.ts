//! OpenCode adapter — maps `opencode run --format json` into the engine-
//! agnostic `NormalizedEvent` model.
//!
//! OpenCode ships TWO structured wires and they are not the same shape:
//!
//!   • `opencode serve` publishes an SSE bus whose frames are
//!     `{ id: "evt_…", type: "session.next.text.delta", properties: {…} }` —
//!     135 event types, deltas and all.
//!   • `opencode run --format json` writes NDJSON of
//!     `{ type, timestamp, sessionID, part: {…} }` — whole parts, no deltas.
//!
//! We spawn the CLI, so this adapter targets the SECOND one. Writing it
//! against the first would parse nothing and show an empty chat rather than an
//! error, which is precisely the failure `BY_AGENT` in `../index.ts` exists to
//! prevent. Every shape below was measured against a real run of opencode
//! 1.18.11, not read off a schema and hoped for.
//!
//! The envelope carries the record name twice: `type` at the top (`tool_use`,
//! `step_finish`) and `part.type` inside (`tool`, `step-finish`). `part.type`
//! is the authoritative union — it is the `Part` schema OpenCode publishes in
//! its own OpenAPI — so that is what this switches on, with the top-level name
//! as a fallback for a record whose part is missing.
//!
//! Two things the RUN wire does not carry, and which are therefore never
//! invented here: the model name (it lives on the session, not on any run
//! record) and the user's own prompt (the CLI does not echo it back). A
//! `session_init` reading "model: unknown" would be a card that states a fact
//! we don't have.
//!
//! Both of them do exist in OpenCode's own store, though, and the desktop app
//! reads the conversation from there rather than from a one-shot run —
//! `opencode_record_read` reconstructs these same records out of
//! `~/.local/share/opencode/opencode.db`, where a part row sits next to the
//! message that owns it and the session that owns that. So this adapter reads
//! two OPTIONAL fields the live run wire simply never sets:
//!
//!   • `role` on the envelope — "user" or "assistant". Absent (a real `run`)
//!     means assistant, which is all `run` ever emits.
//!   • a leading `{"type":"session_init", model, agent, cwd, version}` record.
//!
//! Neither is a guess: a record that lacks them produces exactly the transcript
//! it produced before they existed.

import { asObj, kindFor, norm, titleFor } from "./describe";
import type {
  NormalizedEvent,
  ResultEvent,
  TodoItem,
  ToolCallStatus,
  ToolContent,
  ToolLocation,
} from "../events";

/** OpenCode tool names routed to the describe registry's vocabulary, so its
 *  `list` card says "Listing" like every other engine's directory tool rather
 *  than falling through to a generic JSON dump. */
const TOOL_ALIAS: Record<string, string> = {
  list: "ls",
  task: "agent",
  todoread: "todos",
};

/** OpenCode's own built-in tools. A name outside this set is a plugin or an
 *  MCP server's tool, which our registry has never heard of — for those,
 *  OpenCode's own `state.title` is a better headline than a bare verb. */
const BUILT_IN = new Set([
  "read",
  "write",
  "edit",
  "multiedit",
  "patch",
  "bash",
  "grep",
  "glob",
  "list",
  "webfetch",
  "todowrite",
  "todoread",
  "task",
]);

/** OpenCode names tool arguments in camelCase (`filePath`, `oldString`); the
 *  describe registry — written against Claude's and the native brain's
 *  snake_case — reads `file_path`, `old_string`. Renaming the keys here is
 *  what makes an OpenCode read card say "Reading notes.md" instead of
 *  "Reading" with an empty subject. */
const INPUT_KEY_ALIAS: Record<string, string> = {
  filePath: "file_path",
  oldString: "old_string",
  newString: "new_string",
  subagentType: "subagent_type",
};

function aliasOf(name: string): string {
  return TOOL_ALIAS[norm(name)] ?? name;
}

function aliasInput(raw: unknown): Record<string, unknown> {
  const obj = asObj(raw);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[INPUT_KEY_ALIAS[k] ?? k] = v;
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** OpenCode's four tool states → our five. There is no `cancelled` on this
 *  wire; an aborted run simply stops emitting. */
function statusOf(state: Record<string, unknown>): ToolCallStatus {
  switch (str(state.status)) {
    case "completed":
      return "completed";
    case "error":
      return "error";
    case "running":
      return "running";
    default:
      return "pending";
  }
}

function durationOf(state: Record<string, unknown>): number | undefined {
  const time = asObj(state.time);
  const start = time.start;
  const end = time.end;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return end - start;
}

function parseTodos(input: Record<string, unknown>): TodoItem[] {
  const raw = Array.isArray(input.todos) ? input.todos : [];
  return raw
    .map((t): TodoItem | null => {
      const o = asObj(t);
      const content = String(o.content ?? o.activeForm ?? o.title ?? "");
      if (!content) return null;
      const s = String(o.status ?? "").toLowerCase();
      const status: TodoItem["status"] =
        s === "completed" || s === "done"
          ? "completed"
          : s === "in_progress" || s === "running" || s === "active"
            ? "in_progress"
            : "pending";
      return {
        id: o.id ? String(o.id) : undefined,
        content,
        status,
        activeForm: o.activeForm ? String(o.activeForm) : undefined,
        priority: o.priority ? String(o.priority) : undefined,
      };
    })
    .filter((x): x is TodoItem => x !== null);
}

/** The readable body of a settled tool call.
 *
 *  OpenCode puts a cleaner version of several outputs in `state.metadata` than
 *  in `state.output`: `read` wraps its file in `<path>…<content>` XML for the
 *  model's benefit and keeps the plain text in `metadata.preview`, and `bash`
 *  repeats its stdout as `metadata.output`. Edit and write carry the literal
 *  before/after in their INPUT, so those render as a real diff block rather
 *  than the string "Edit applied successfully." */
function toolContent(
  name: string,
  input: Record<string, unknown>,
  state: Record<string, unknown>,
): ToolContent[] {
  const n = norm(name);
  const meta = asObj(state.metadata);
  const output = str(state.output) ?? str(state.error) ?? "";
  const path = String(input.file_path ?? input.path ?? "");

  if (n === "edit" && path) {
    return [
      {
        type: "diff",
        path,
        oldText: input.old_string != null ? String(input.old_string) : undefined,
        newText: input.new_string != null ? String(input.new_string) : "",
      },
    ];
  }
  if (n === "write" && path) {
    return [{ type: "diff", path, newText: String(input.content ?? "") }];
  }
  if (n === "read") {
    const preview = str(meta.preview) ?? str(asObj(meta.display).text);
    if (preview) return [{ type: "content", text: preview }];
  }
  if (n === "bash") {
    const stdout = str(meta.output);
    if (stdout) return [{ type: "content", text: stdout }];
  }
  return output ? [{ type: "content", text: output }] : [];
}

/** Files a tool touched, so the editor can follow along. */
function locationsOf(
  name: string,
  input: Record<string, unknown>,
): ToolLocation[] | undefined {
  const n = norm(name);
  if (n !== "read" && n !== "write" && n !== "edit" && n !== "multiedit") {
    return undefined;
  }
  const path = String(input.file_path ?? input.path ?? "");
  return path ? [{ path }] : undefined;
}

/** A `bash` that exits non-zero still arrives as `status: "completed"` —
 *  OpenCode means "the tool ran", not "the command succeeded". The exit code
 *  is in `metadata.exit`, and without reading it a failing build renders as a
 *  green card. */
function isErrorOf(name: string, state: Record<string, unknown>): boolean {
  if (statusOf(state) === "error") return true;
  if (norm(name) === "bash") {
    const exit = asObj(state.metadata).exit;
    return typeof exit === "number" && exit !== 0;
  }
  return false;
}

/** AI-SDK finish reasons → our terminal subtype. `tool-calls` is not terminal
 *  at all: it means the model stopped to run a tool and another step follows. */
function subtypeOf(reason: string | undefined): ResultEvent["subtype"] {
  return reason === "error" ? "error" : "success";
}

/** Accept either the parsed records or the raw NDJSON blob the CLI wrote, so
 *  a caller holding stdout doesn't have to know the framing. Unparseable
 *  lines are skipped rather than thrown on — a run that printed one bad line
 *  should still render the rest of the conversation. */
function records(raw: unknown): Record<string, unknown>[] {
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("{"))
          .map((line) => {
            try {
              return JSON.parse(line) as unknown;
            } catch {
              return null;
            }
          })
          .filter((v) => v !== null)
      : [];
  return rows.map((r) => asObj(r));
}

/** Normalize an `opencode run --format json` stream into the shared model.
 *  Pure + deterministic: the stream is append-only, so re-running this over a
 *  longer prefix mints the same ids for the records it already saw and the
 *  reducer folds updates in place. */
export function normalizeOpencode(
  raw: unknown,
  sessionId: string,
): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const rows = records(raw);

  // Summed across every step of the run, so the closing card can report what
  // the whole answer cost rather than what its last model call cost.
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costUsd = 0;
  let lastReason: string | undefined;
  let sawStep = false;
  let lastTs = 0;

  rows.forEach((r, i) => {
    const part = asObj(r.part);
    // The top-level name uses underscores (`step_finish`) and the part uses
    // hyphens (`step-finish`); the part is authoritative, so only fall back
    // when a record arrives without one.
    const kind = str(part.type) ?? String(r.type ?? "").replace(/_/g, "-");
    const ts = typeof r.timestamp === "number" ? r.timestamp : i;
    lastTs = ts;
    const id = str(part.id) ?? `${kind}:${i}`;
    // Only the desktop's record reader knows who spoke; `opencode run` emits
    // the assistant's side alone, so an envelope without a role is the
    // assistant's by construction rather than by assumption.
    const role = str(r.role) === "user" ? "user" : "assistant";

    switch (kind) {
      case "session_init":
      case "session-init": {
        // Not on the run wire at all — this comes from the session row, and
        // `model` is the object OpenCode itself stores: which provider, which
        // model, which variant. For someone running a BYO plan that is the one
        // thing worth confirming at the top of a transcript.
        const model = asObj(r.model);
        const provider = str(model.providerID);
        const name = str(model.id);
        out.push({
          kind: "session_init",
          id: `${sessionId}:init`,
          sessionId,
          ts,
          source: "agent",
          // `provider/model` is how OpenCode's own `-m` flag spells it, so the
          // card reads back the same string the user would type.
          model: name ? (provider ? `${provider}/${name}` : name) : null,
          provider,
          cwd: str(r.cwd),
          // The run wire never lists tools, and OpenCode's set depends on the
          // agent, plugins and MCP servers in play. An invented list would be
          // a card stating something we didn't read.
          tools: [],
          // OpenCode calls this an "agent" (`build`, `plan`); it is the same
          // idea as Claude's permission mode — what this session may do.
          permissionMode: str(r.agent),
        });
        break;
      }

      case "text": {
        const text = String(part.text ?? "").trim();
        if (!text) break;
        out.push({
          kind: "text",
          id,
          sessionId,
          ts,
          source: role === "user" ? "user" : "agent",
          role,
          text,
        });
        break;
      }

      case "reasoning": {
        const text = String(part.text ?? "").trim();
        if (!text) break;
        out.push({
          kind: "reasoning",
          id,
          sessionId,
          ts,
          source: "agent",
          text,
          durationMs: durationOf(part),
        });
        break;
      }

      case "tool": {
        const rawName = str(part.tool) ?? "tool";
        const state = asObj(part.state);
        const input = aliasInput(state.input);
        const callId = str(part.callID) ?? id;
        const alias = aliasOf(rawName);

        // The checklist is a first-class surface, not a tool card — the same
        // treatment Claude's TodoWrite gets, so the two engines drive one UI.
        if (norm(rawName) === "todowrite" || norm(rawName) === "todoread") {
          out.push({
            kind: "todo",
            id,
            sessionId,
            ts,
            source: "agent",
            todos: parseTodos(input),
          });
          break;
        }

        const status = statusOf(state);
        const settled = status === "completed" || status === "error";
        const isError = isErrorOf(rawName, state);
        const output = str(state.output) ?? str(state.error);
        // Our registry knows OpenCode's built-ins; for a plugin or MCP tool it
        // has never seen, OpenCode's own title beats a generic headline.
        const title = BUILT_IN.has(norm(rawName))
          ? titleFor(
              alias,
              input,
              settled ? { is_error: isError, content: output ?? "" } : undefined,
            )
          : (str(state.title) ?? titleFor(alias, input));

        out.push({
          kind: "tool_call",
          id: `tool:${callId}`,
          sessionId,
          ts,
          source: settled ? "environment" : "agent",
          partial: !settled,
          callId,
          toolKind: kindFor(alias, input),
          status,
          toolName: rawName,
          title,
          input,
          content: settled ? toolContent(rawName, input, state) : undefined,
          output,
          isError: isError || undefined,
          locations: locationsOf(rawName, input),
          durationMs: durationOf(state),
        });
        break;
      }

      case "subtask": {
        // A delegated run. It reads as a dispatch card, keyed on the part id
        // so a later update of the same subtask lands on the same card.
        const input = {
          subagent_type: str(part.agent) ?? "agent",
          description: str(part.description) ?? "",
          prompt: str(part.prompt) ?? "",
        };
        out.push({
          kind: "tool_call",
          id: `tool:${id}`,
          sessionId,
          ts,
          source: "agent",
          callId: id,
          toolKind: kindFor("agent", input),
          status: "running",
          toolName: "task",
          title: titleFor("agent", input),
          input,
        });
        break;
      }

      case "patch": {
        const files = Array.isArray(part.files)
          ? (part.files as unknown[]).map((f) => String(f))
          : [];
        if (files.length === 0) break;
        out.push({
          kind: "tool_call",
          id: `tool:${id}`,
          sessionId,
          ts,
          source: "environment",
          callId: id,
          toolKind: "edit",
          status: "completed",
          toolName: "patch",
          title:
            files.length === 1
              ? `Editing ${basename(files[0]!)}`
              : `Editing ${files.length} files`,
          input: { files },
          locations: files.map((path) => ({ path })),
        });
        break;
      }

      case "retry": {
        // The one record that carries a provider failure. OpenCode retries
        // past it, and the user's complaint about every other tool is that the
        // real error gets swallowed and replaced with a house error — so this
        // surfaces OpenCode's own message verbatim.
        const err = asObj(part.error);
        const message =
          str(asObj(err.data).message) ?? str(err.name) ?? "the request failed";
        const attempt = num(part.attempt);
        out.push({
          kind: "error",
          id,
          sessionId,
          ts,
          source: "environment",
          message: attempt
            ? `Attempt ${attempt} failed: ${message} — retrying.`
            : `${message} — retrying.`,
          errorId: str(err.name),
        });
        break;
      }

      case "file": {
        // Attachments. Only an inline image has somewhere to go in the shared
        // model; a `file:///` reference is already visible as the path on
        // whatever tool call touched it.
        const mime = str(part.mime) ?? "";
        const url = str(part.url) ?? "";
        if (!mime.startsWith("image/") || !url.startsWith("data:")) break;
        const data = url.slice(url.indexOf(",") + 1);
        if (!data) break;
        out.push({
          kind: "image",
          id,
          sessionId,
          ts,
          source: "user",
          role: "user",
          mediaType: mime,
          data,
        });
        break;
      }

      case "step-finish": {
        sawStep = true;
        const tokens = asObj(part.tokens);
        const cache = asObj(tokens.cache);
        const input = num(tokens.input);
        const read = num(cache.read);
        const write = num(cache.write);
        const output_ = num(tokens.output);
        inputTokens += input;
        outputTokens += output_;
        cacheRead += read;
        cacheWrite += write;
        costUsd += num(part.cost);
        lastReason = str(part.reason);
        out.push({
          kind: "usage",
          id,
          sessionId,
          ts,
          source: "environment",
          // OpenCode's own arithmetic is `input + output + cache.read == total`
          // — `input` counts ONLY the uncached share, so the cache planes are
          // additions here, not a subset to be netted out.
          contextTokens: input + read + write,
          outputTokens: output_,
        });
        break;
      }

      // `step-start` opens a model call and carries nothing but its own ids;
      // `agent` names which agent produced the message; `snapshot` records a
      // git ref for rewind; `compaction` notes that the history was squashed.
      // All four are OpenCode's bookkeeping, and none of them is chat.
      default:
        break;
    }
  });

  // One closing card for the run, not one per model call. `tool-calls` means
  // the model paused to run a tool and another step follows, so a stream that
  // ends there ended early (killed, or still in flight) and gets no result.
  if (sawStep && lastReason && lastReason !== "tool-calls") {
    out.push({
      kind: "result",
      id: "result",
      sessionId,
      ts: lastTs,
      source: "environment",
      subtype: subtypeOf(lastReason),
      usage: {
        inputTokens,
        outputTokens,
        cacheRead,
        cacheWrite,
      },
      costUsd,
      stopReason: lastReason,
    });
  }

  return out;
}
