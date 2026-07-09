//! Tool-call description registry for the native Aura chat.
//!
//! Lifted out of the 4000-line `ManagerChatView` monolith. This module is
//! the single place that turns a raw `(name, input, result)` tool-call
//! triple into a uniform `ToolView` the card can render — independent of
//! which brain emitted it.
//!
//! Backend tool naming differs per brain: the Anthropic-API brain speaks
//! snake_case (`read_file`/`bash`/`ask_user`); CLI brains relay Claude's /
//! Gemini's native PascalCase (`Read`/`Bash`/`AskUserQuestion`/`Agent`).
//! `describeTool` normalizes every alias through
//! `name.toLowerCase().replace(/[-_]/g, "")` so the switch only carries one
//! casing.
//!
//! `tier` decides visual prominence:
//!   "thinking" — context-gathering only, doesn't change the world. Renders
//!                as a single dim line that disappears into the activity
//!                stream.
//!   "action"   — actually mutates code, runs commands, dispatches subagents,
//!                or asks the user. Renders as a proper card so the user
//!                notices it.
//!
//! `glyph` + `accent` drive the card's leading icon and pip colour; `diff`
//! carries a minimal unified diff for edit/write tools so the card can show
//! added/removed hunks instead of opaque JSON.

import type {
  ToolView,
  ToolStep,
  ToolTier,
  ToolResult,
  ToolGlyph,
  ToolAccent,
  AskQuestion,
  AskOption,
  ToolField,
} from "./types";

/** Cap a built unified diff so a giant Write doesn't blow out the card. */
const MAX_DIFF_LINES = 80;

export function describeTool(
  name: string,
  input: unknown,
  result?: ToolResult,
): ToolView {
  const obj =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  // Strip the `mcp__<server>__` envelope first so a daemon-relayed
  // `mcp__aura-vcs__aura_rewind` normalizes to the same `aurarewind` key as
  // the native brain's bare `aura_rewind` alias — one switch arm, not two.
  const leaf = stripMcpNamespace(name);
  const norm = leaf.toLowerCase().replace(/[-_]/g, "");
  const metric = resultMetric(name, result);

  switch (norm) {
    case "read":
    case "readfile": {
      const path = String(obj.file_path ?? obj.path ?? "");
      return {
        verb: "Reading",
        tier: "thinking",
        subject: basename(path),
        mono: true,
        metric,
        glyph: "read",
        accent: "neutral",
        // An image read renders the picture itself, inline — the path is a real
        // local file on this machine, resolvable via the Tauri asset protocol.
        ...(isImagePath(path) ? { imagePath: path } : {}),
      };
    }
    case "glob":
    case "globsearch": {
      const pattern = String(obj.pattern ?? obj.glob ?? "");
      return {
        verb: "Finding",
        tier: "thinking",
        subject: pattern,
        mono: true,
        metric,
        glyph: "glob",
        accent: "neutral",
      };
    }
    case "grep":
    case "search": {
      const pattern = String(obj.pattern ?? obj.query ?? "");
      const path = obj.path ? String(obj.path) : undefined;
      return {
        verb: "Searching",
        tier: "thinking",
        subject: pattern,
        mono: true,
        metric: metric ?? (path ? `in ${basename(path)}` : undefined),
        glyph: "search",
        accent: "neutral",
      };
    }
    case "ls":
    case "listdir": {
      const path = String(obj.path ?? "");
      return {
        verb: "Listing",
        tier: "thinking",
        subject: path,
        mono: true,
        metric,
        glyph: "list",
        accent: "neutral",
      };
    }
    case "webfetch":
    case "fetch": {
      const url = String(obj.url ?? "");
      return {
        verb: "Fetching",
        tier: "thinking",
        subject: url,
        mono: true,
        metric,
        glyph: "fetch",
        accent: "neutral",
      };
    }
    case "websearch": {
      const q = String(obj.query ?? "");
      return {
        verb: "Web search",
        tier: "thinking",
        subject: q,
        metric,
        glyph: "search",
        accent: "neutral",
      };
    }
    case "auraask": {
      return {
        verb: "Aura ask",
        tier: "thinking",
        subject: truncate(String(obj.question ?? ""), 100),
        metric,
        glyph: "ask",
        accent: "neutral",
      };
    }
    // ── Aura semantic-engine MCP tools (snake_case `aura_*` aliases) ──────
    // The native brain can call these as first-class MCP tools (not just
    // shelled-out `aura …` bash). Same humanized verbs as describeAuraBash,
    // glyphed as board/page/review/plan work.
    case "aurataskslist":
    case "aurataskssready":
    case "aurataskready": {
      return {
        verb: "Listing tasks",
        tier: "thinking",
        subject: undefined,
        metric,
        glyph: "task",
        accent: "neutral",
      };
    }
    case "aurataskget": {
      const id = String(obj.id ?? obj.handle ?? obj.task ?? "");
      return {
        verb: "Reading task",
        tier: "thinking",
        subject: id || undefined,
        mono: !!id,
        metric,
        glyph: "task",
        accent: "neutral",
      };
    }
    case "aurataskcreate": {
      const title = String(obj.title ?? "");
      return {
        verb: "Creating task",
        tier: "action",
        subject: truncate(title, 90) || undefined,
        metric,
        glyph: "task",
        accent: "accent",
      };
    }
    case "aurataskupdate": {
      const id = String(obj.id ?? obj.handle ?? obj.task ?? "");
      const status = obj.status ? String(obj.status) : undefined;
      return {
        verb: "Updating task",
        tier: "action",
        subject: id ? (status ? `${id} → ${status}` : id) : status,
        mono: !!id,
        metric,
        glyph: "task",
        accent: "accent",
      };
    }
    case "aurapageslist": {
      return {
        verb: "Listing pages",
        tier: "thinking",
        subject: undefined,
        metric,
        glyph: "page",
        accent: "neutral",
      };
    }
    case "aurapageread": {
      const slug = String(obj.slug ?? obj.path ?? obj.title ?? "");
      return {
        verb: "Reading page",
        tier: "thinking",
        subject: basename(slug) || slug || undefined,
        mono: !!slug,
        metric,
        glyph: "page",
        accent: "neutral",
      };
    }
    case "aurapagewrite": {
      const slug = String(obj.slug ?? obj.path ?? obj.title ?? "");
      return {
        verb: "Writing page",
        tier: "action",
        subject: basename(slug) || slug || undefined,
        mono: !!slug,
        metric,
        glyph: "page",
        accent: "accent",
      };
    }
    case "prove":
    case "auraprove": {
      return {
        verb: "Proving",
        tier: "action",
        subject: truncate(String(obj.goal ?? obj.behavior ?? ""), 100),
        metric,
        glyph: "review",
        accent: "neutral",
      };
    }
    case "review":
    case "aurareview":
    case "auraprreview": {
      const base = obj.base ? String(obj.base) : undefined;
      return {
        verb: "Reviewing",
        tier: "action",
        subject: base ? `vs ${base}` : "working changes",
        mono: !!base,
        metric,
        glyph: "review",
        accent: "neutral",
      };
    }
    // Aura semantic scalpel — revert ONE function/class to its last safe
    // state instead of a whole-commit revert. Amber edit card so the
    // surgical nature reads at a glance.
    case "rewind":
    case "aurarewind": {
      const id = String(obj.identifier ?? obj.symbol ?? obj.node ?? "");
      const path = obj.file_path ? basename(String(obj.file_path)) : "";
      return {
        verb: "Bringing back",
        tier: "action",
        subject: path ? (id ? `${id} · ${path}` : path) : id,
        mono: true,
        metric,
        glyph: "edit",
        accent: "amber",
      };
    }
    case "write":
    case "writefile": {
      const path = String(obj.file_path ?? obj.path ?? "");
      const content =
        obj.content !== undefined
          ? String(obj.content)
          : obj.contents !== undefined
            ? String(obj.contents)
            : undefined;
      return {
        verb: "Writing",
        tier: "action",
        subject: basename(path),
        mono: true,
        metric,
        glyph: "write",
        accent: "accent",
        diff: content !== undefined ? buildWriteDiff(content) : undefined,
      };
    }
    case "edit":
    case "editfile": {
      const path = String(obj.file_path ?? obj.path ?? "");
      return {
        verb: "Editing",
        tier: "action",
        subject: basename(path),
        mono: true,
        metric,
        glyph: "edit",
        accent: "accent",
        diff: buildEditDiff(
          obj.old_string ?? obj.oldText ?? obj.old,
          obj.new_string ?? obj.newText ?? obj.new,
        ),
      };
    }
    case "multiedit": {
      const path = String(obj.file_path ?? obj.path ?? "");
      return {
        verb: "Editing",
        tier: "action",
        subject: basename(path),
        mono: true,
        metric,
        glyph: "edit",
        accent: "accent",
        diff: buildMultiEditDiff(obj.edits),
      };
    }
    case "bash": {
      const cmd = String(obj.command ?? "");
      const desc = obj.description ? String(obj.description) : undefined;
      // Aura CLI invocations get human-friendly verbs + the natural-
      // language goal as the subject. The raw `aura plan "Build web app
      // where..."` shell-escaped command is noise on a desktop surface.
      const aura = describeAuraBash(cmd, desc, metric);
      if (aura) return aura;
      // Read-only bash commands (cat/ls/which/echo, etc) are really
      // thinking-tier — they don't change anything.
      const tier: ToolTier = isReadOnlyBash(cmd) ? "thinking" : "action";
      // Subject is a single-line shell snippet — heredocs and multi-line
      // commands get collapsed to the first non-empty line so the card
      // header stays scannable. `desc` (Anthropic-API tools carry a
      // human-written description) takes priority when present.
      const headline = desc?.trim() || firstLine(cmd) || cmd;
      return {
        verb: "Running",
        tier,
        subject: truncate(headline, 120),
        mono: !desc?.trim(),
        // When the step has a human description, the raw command rides along
        // as a dim mono preview (Conductor-style) so the collapsed row reads
        // "Ran · <what> · `the command`" instead of hiding the command.
        aux: desc?.trim() ? truncate(firstLine(cmd) || cmd, 120) : undefined,
        // Full command for the expanded terminal well — `> <command>` then its
        // output in one dark box (a real shell), rather than a header chip and
        // a separate output pane. Untruncated; the well scrolls horizontally.
        command: cmd,
        metric,
        hideRawInput: !!desc?.trim(),
        glyph: "run",
        accent: "neutral",
      };
    }
    case "agent":
    case "spawnsubagent":
    case "subagent": {
      const provider = String(
        obj.subagent_type ?? obj.provider ?? obj.agent ?? "agent",
      );
      const desc = String(obj.description ?? "");
      const prompt = String(obj.prompt ?? "");
      return {
        verb: `Dispatched ${provider}`,
        tier: "action",
        subject: desc || undefined,
        body: prompt ? truncate(prompt, 280) : undefined,
        metric,
        glyph: "dispatch",
        accent: "accent",
      };
    }
    case "waitsubagent": {
      const id = obj.task_id ?? "?";
      return {
        verb: "Waiting",
        tier: "thinking",
        subject: `task #${id}`,
        metric,
        glyph: "dispatch",
        accent: "neutral",
      };
    }
    case "askuserquestion":
    case "askuser":
    case "ask": {
      // Parse the full questions+options shape into a structured `ask` view so
      // the card renders clean option rows — never the raw `{questions:[…]}`
      // JSON the user called out as bulky.
      const rawQuestions = Array.isArray(obj.questions) ? obj.questions : [];
      const questions: AskQuestion[] = rawQuestions
        .map((q): AskQuestion | null => {
          const o =
            q && typeof q === "object" ? (q as Record<string, unknown>) : {};
          const header = o.header ? String(o.header) : undefined;
          const question = String(o.question ?? o.header ?? "");
          const rawOptions = Array.isArray(o.options) ? o.options : [];
          const options: AskOption[] = rawOptions
            .map((opt): AskOption | null => {
              const oo =
                opt && typeof opt === "object"
                  ? (opt as Record<string, unknown>)
                  : {};
              const label = String(oo.label ?? "");
              const description = oo.description
                ? String(oo.description)
                : undefined;
              return label ? { label, description } : null;
            })
            .filter((x): x is AskOption => x !== null);
          return question || options.length
            ? { header, question, multiSelect: o.multiSelect === true, options }
            : null;
        })
        .filter((x): x is AskQuestion => x !== null);
      // `aura_ask` uses a flat `{ question: "…" }` shape with no options.
      const directQuestion = obj.question ? String(obj.question) : "";
      const first = questions[0];
      const headline = first?.question || directQuestion || "";
      return {
        verb: "Asking you",
        tier: "action",
        subject:
          first?.header || (headline ? truncate(headline, 80) : undefined),
        // When there are structured questions the card renders `ask`; the flat
        // single-question form falls back to `body`.
        body: questions.length ? undefined : headline || undefined,
        ask: questions.length ? { questions } : undefined,
        hideRawInput: true,
        metric,
        glyph: "ask",
        accent: "amber",
      };
    }
    // Plan mode (Claude Code): the agent surfaces its plan for approval. Render
    // the markdown plan in a calm plan block, not a raw `{plan:"…"}` blob.
    case "exitplanmode": {
      const plan = typeof obj.plan === "string" ? obj.plan.trim() : "";
      // First heading / non-empty line → a one-line subject so the collapsed
      // row reads "Shared a plan · <title>" before you expand it.
      const firstLine = plan
        .split("\n")
        .map((l) => l.replace(/^#+\s*/, "").trim())
        .find((l) => l.length > 0);
      return {
        verb: "Shared a plan",
        tier: "action",
        subject: firstLine ? truncate(firstLine, 80) : undefined,
        planMarkdown: plan || undefined,
        hideRawInput: true,
        glyph: "plan",
        accent: "accent",
      };
    }
    case "todowrite":
    case "todos": {
      const todos = Array.isArray(obj.todos) ? obj.todos : [];
      // Convert each todo into a structured step so the card can render
      // an Aceternity-style multi-step loader (○/●/✓ status circles)
      // instead of dumping the raw JSON shape. The model populates
      // `content`/`activeForm`/`status` fields per todo.
      const steps: ToolStep[] = todos
        .map((t) => {
          const o =
            t && typeof t === "object" ? (t as Record<string, unknown>) : {};
          const label =
            (o.content as string | undefined) ??
            (o.activeForm as string | undefined) ??
            (o.title as string | undefined) ??
            "";
          const rawStatus = String(o.status ?? "").toLowerCase();
          const status: ToolStep["status"] =
            rawStatus === "completed" || rawStatus === "done"
              ? "completed"
              : rawStatus === "in_progress" ||
                  rawStatus === "running" ||
                  rawStatus === "active"
                ? "in_progress"
                : "pending";
          return label ? { label, status } : null;
        })
        .filter((s): s is ToolStep => s !== null);
      const doneCount = steps.filter((s) => s.status === "completed").length;
      return {
        verb: "Planning",
        tier: "action",
        subject: `${todos.length} step${todos.length === 1 ? "" : "s"}`,
        steps: steps.length > 0 ? steps : undefined,
        metric:
          metric ?? (steps.length > 0 ? `${doneCount}/${steps.length}` : undefined),
        hideRawInput: true,
        glyph: "task",
        accent: "accent",
      };
    }
    // Aura plan tools (MCP): discover/lock/next a wave plan.
    case "auraplandiscover":
    case "auraplanlock":
    case "auraplannext": {
      const goal = obj.objective ? String(obj.objective) : "";
      const verb =
        norm === "auraplandiscover"
          ? "Planning"
          : norm === "auraplanlock"
            ? "Locking plan"
            : "Next wave";
      return {
        verb,
        tier: "action",
        subject: goal ? truncate(goal, 100) : undefined,
        metric,
        glyph: "plan",
        accent: "accent",
      };
    }
    case "notebookedit": {
      const path = String(obj.notebook_path ?? obj.path ?? "");
      return {
        verb: "Editing notebook",
        tier: "action",
        subject: basename(path),
        mono: true,
        metric,
        glyph: "edit",
        accent: "accent",
      };
    }
    default: {
      // Aura semantic-engine MCP tools (status/doctor/snapshot/memory/
      // sentinel/episodic/…) not given a dedicated rich arm above — a
      // table-driven humanized view so `mcp__aura-vcs__aura_log_intent`
      // reads as "Recording the reason", never `Mcp Aura Vcs Aura Log Intent`.
      const aura = describeAuraMcpTool(norm, obj, metric);
      if (aura) return aura;
      // Unknown tool — show the namespace-stripped leaf as verb, condensed
      // input as subject, and the inputs as humanized key→value rows (never
      // raw JSON). Default to action tier (better to over-surface than miss).
      return {
        verb: prettyToolName(leaf),
        tier: "action",
        subject: smartSummary(obj),
        fields: humanizeFields(obj),
        hideRawInput: true,
        metric,
        glyph: "generic",
        accent: "neutral",
      };
    }
  }
}

/** Strip the daemon's `mcp__<server>__` envelope off a relayed MCP tool
 *  name so the leaf normalizes to the same key as the brain's bare alias.
 *  `mcp__aura-vcs__aura_rewind` → `aura_rewind`; bare names pass through.
 *  Mirrors the leaf-extraction in `transcript/model.ts` so both surfaces
 *  agree on what a tool is called. */
export function stripMcpNamespace(name: string): string {
  const m = name.match(/^mcp__[^_]+(?:__|_)(.+)$/);
  return m ? m[1]! : name;
}

// ── Aura semantic-engine MCP registry ────────────────────────────────────
//
// The native brain and CLI brains can call the whole `aura-vcs` MCP surface
// as first-class tools. The headline ones (task create/update, page
// read/write, plan, prove, review, rewind) get dedicated rich arms in the
// switch above. Everything else — status, doctor, intent, snapshot, memory,
// sentinel, episodic recall, live-sync, handover, a2a tasks, … — is described
// from this flat table so each reads as a humanized verb + glyph instead of
// the raw `aura_log_intent` identifier. Keys are the normalized form
// (lowercased, separators stripped) the switch uses; `subjectKeys` lists the
// input fields to pull a subject from, falling back to a generic scan.

type AuraMcpDesc = {
  verb: string;
  tier: ToolTier;
  glyph: ToolGlyph;
  /** Defaults to "accent" for action tier, "neutral" for thinking. */
  accent?: ToolAccent;
  /** Input keys to pull the subject from, in priority order. */
  subjectKeys?: string[];
  /** Render the subject in mono (ids, paths, symbols). */
  mono?: boolean;
};

const AURA_MCP_TOOLS: Record<string, AuraMcpDesc> = {
  // ── Read-only semantic state (thinking) ──
  aurastatus: { verb: "Aura status", tier: "thinking", glyph: "review" },
  auradoctor: { verb: "Health check", tier: "thinking", glyph: "review" },
  auradefs: {
    verb: "Reading defs",
    tier: "thinking",
    glyph: "read",
    subjectKeys: ["identifier", "symbol", "name", "query"],
    mono: true,
  },
  aurarefs: {
    verb: "Finding refs",
    tier: "thinking",
    glyph: "search",
    subjectKeys: ["identifier", "symbol", "name", "query"],
    mono: true,
  },
  aurareadhistory: {
    verb: "Reading history",
    tier: "thinking",
    glyph: "read",
    subjectKeys: ["identifier", "file_path", "path"],
    mono: true,
  },
  auraintentquery: {
    verb: "Looking up reasons",
    tier: "thinking",
    glyph: "search",
    subjectKeys: ["query", "question"],
  },
  auraintentsummary: {
    verb: "Reasons summary",
    tier: "thinking",
    glyph: "review",
  },
  auratasterules: { verb: "Taste rules", tier: "thinking", glyph: "review" },
  auracontextbudget: {
    verb: "Context budget",
    tier: "thinking",
    glyph: "review",
  },
  aurausage: { verb: "Usage", tier: "thinking", glyph: "review" },
  auraroutesuggest: {
    verb: "Routing",
    tier: "thinking",
    glyph: "dispatch",
    subjectKeys: ["task", "objective", "query"],
  },
  aurasnapshotlist: {
    verb: "Listing snapshots",
    tier: "thinking",
    glyph: "read",
    subjectKeys: ["file_path", "path"],
    mono: true,
  },
  auraattestlist: { verb: "Genuine records", tier: "thinking", glyph: "review" },
  auraattestverify: {
    verb: "Verifying genuine record",
    tier: "thinking",
    glyph: "review",
    subjectKeys: ["id", "commit", "sha"],
    mono: true,
  },
  auraimpactscrossrepo: {
    verb: "Cross-repo impacts",
    tier: "thinking",
    glyph: "review",
    subjectKeys: ["repo", "path"],
    mono: true,
  },
  // ── Cross-branch live impacts (thinking read, action resolve) ──
  auraliveimpacts: { verb: "Checking impacts", tier: "thinking", glyph: "review" },
  auralivesyncstatus: { verb: "Sync status", tier: "thinking", glyph: "review" },
  // ── Episodic memory recall (thinking) ──
  auraepisodicrecall: {
    verb: "Recalling episodes",
    tier: "thinking",
    glyph: "search",
    subjectKeys: ["query", "session_id", "agent"],
  },
  auraepisodicrecallcloud: {
    verb: "Recalling episodes",
    tier: "thinking",
    glyph: "search",
    subjectKeys: ["query", "session_id", "agent"],
  },
  auraepisodictimeline: { verb: "Episode timeline", tier: "thinking", glyph: "search" },
  auraepisodicnarrate: {
    verb: "Narrating episodes",
    tier: "thinking",
    glyph: "search",
    subjectKeys: ["session_id", "query"],
  },
  auraepisodicsessionarc: {
    verb: "Session arc",
    tier: "thinking",
    glyph: "search",
    subjectKeys: ["session_id"],
    mono: true,
  },
  auraepisodicmultisessionarc: { verb: "Session arc", tier: "thinking", glyph: "search" },
  auraepisodicagentdigest: {
    verb: "Agent digest",
    tier: "thinking",
    glyph: "search",
    subjectKeys: ["agent"],
  },
  // ── Memory store (read thinking, write action) ──
  auramemoryread: {
    verb: "Reading memory",
    tier: "thinking",
    glyph: "read",
    subjectKeys: ["key", "query", "name"],
    mono: true,
  },
  auramemorycloudlist: { verb: "Listing memory", tier: "thinking", glyph: "read" },
  auramemorywrite: {
    verb: "Writing memory",
    tier: "action",
    glyph: "write",
    subjectKeys: ["key", "name", "summary", "text"],
    mono: true,
  },
  auramemoryforget: {
    verb: "Forgetting memory",
    tier: "action",
    glyph: "write",
    subjectKeys: ["key", "name"],
    mono: true,
  },
  auramemorycompact: { verb: "Compacting memory", tier: "action", glyph: "write" },
  auramemorycloudpush: { verb: "Pushing memory", tier: "action", glyph: "dispatch" },
  // ── Handover (list thinking, generate/push action) ──
  aurahandover: {
    verb: "Handing over",
    tier: "action",
    glyph: "dispatch",
    subjectKeys: ["agent"],
  },
  aurahandovercloudlist: { verb: "Listing handovers", tier: "thinking", glyph: "dispatch" },
  aurahandovercloudpush: { verb: "Pushing handover", tier: "action", glyph: "dispatch" },
  // ── Intent / snapshot (action) ──
  auralogintent: {
    verb: "Recording the reason",
    tier: "action",
    glyph: "write",
    subjectKeys: ["intent", "summary", "message", "text"],
  },
  aurasnapshot: {
    verb: "Saving a point",
    tier: "action",
    glyph: "write",
    subjectKeys: ["file_path", "path"],
    mono: true,
  },
  // ── Live impacts / sync (action) ──
  auraliveresolve: {
    verb: "Resolving impact",
    tier: "action",
    glyph: "review",
    subjectKeys: ["id", "alert_id"],
    mono: true,
  },
  auralivesyncpush: { verb: "Pushing changes", tier: "action", glyph: "dispatch" },
  auralivesyncpull: { verb: "Pulling changes", tier: "action", glyph: "dispatch" },
  // ── Team messaging ──
  auramsgsend: {
    verb: "Messaging team",
    tier: "action",
    glyph: "dispatch",
    subjectKeys: ["message", "body", "text", "to"],
  },
  auramsglist: { verb: "Reading messages", tier: "thinking", glyph: "dispatch" },
  // ── Sentinel / zones ──
  aurasentinelstatus: { verb: "Sentinel status", tier: "thinking", glyph: "dispatch" },
  aurasentinelinbox: { verb: "Sentinel inbox", tier: "thinking", glyph: "dispatch" },
  aurasentinelagents: { verb: "Sentinel agents", tier: "thinking", glyph: "dispatch" },
  aurasentinelsend: {
    verb: "Sentinel send",
    tier: "action",
    glyph: "dispatch",
    subjectKeys: ["message", "to", "text"],
  },
  aurasentinelrelease: {
    verb: "Releasing zone",
    tier: "action",
    glyph: "dispatch",
    subjectKeys: ["zone", "path", "scope"],
    mono: true,
  },
  aurazoneclaim: {
    verb: "Claiming zone",
    tier: "action",
    glyph: "dispatch",
    subjectKeys: ["zone", "path", "scope"],
    mono: true,
  },
  // ── A2A task board ──
  auraa2ataskcreate: {
    verb: "Creating task",
    tier: "action",
    glyph: "task",
    subjectKeys: ["title"],
  },
  auraa2ataskget: {
    verb: "Reading task",
    tier: "thinking",
    glyph: "task",
    subjectKeys: ["id", "handle", "task"],
    mono: true,
  },
  auraa2atasklist: { verb: "Listing tasks", tier: "thinking", glyph: "task" },
  auraa2ataskpatch: {
    verb: "Updating task",
    tier: "action",
    glyph: "task",
    subjectKeys: ["id", "handle", "task", "status"],
    mono: true,
  },
  // ── Orchestration / subagents ──
  auraorchestratestatus: { verb: "Orchestration status", tier: "thinking", glyph: "dispatch" },
  aurasubagentmonitor: {
    verb: "Watching subagent",
    tier: "thinking",
    glyph: "dispatch",
    subjectKeys: ["task_id", "id"],
    mono: true,
  },
  // ── Suggest-edit ──
  aurasuggestedit: {
    verb: "Suggesting edit",
    tier: "action",
    glyph: "edit",
    subjectKeys: ["file_path", "path", "identifier"],
    mono: true,
  },
  // ── Gemini large-context reads ──
  aurageminiread: {
    verb: "Reading (Gemini)",
    tier: "thinking",
    glyph: "read",
    subjectKeys: ["file_path", "path", "query"],
    mono: true,
  },
  aurageminiskim: {
    verb: "Skimming (Gemini)",
    tier: "thinking",
    glyph: "read",
    subjectKeys: ["glob", "path", "query"],
    mono: true,
  },
  aurageminibatch: { verb: "Reading (Gemini)", tier: "thinking", glyph: "read" },
  // ── Commit-scoped review ──
  auraprcommitreviewgenerate: {
    verb: "Reviewing commit",
    tier: "action",
    glyph: "review",
    subjectKeys: ["commit", "sha", "id"],
    mono: true,
  },
  auraprcommitreviewget: {
    verb: "Reading review",
    tier: "thinking",
    glyph: "review",
    subjectKeys: ["commit", "sha", "id"],
    mono: true,
  },
  auraprcommitreviewlist: { verb: "Listing reviews", tier: "thinking", glyph: "review" },
  // ── Session ──
  aurasessionresume: {
    verb: "Resuming session",
    tier: "action",
    glyph: "generic",
    subjectKeys: ["session_id", "id"],
    mono: true,
  },
  aurasessionsummarize: {
    verb: "Summarizing session",
    tier: "action",
    glyph: "generic",
    subjectKeys: ["session_id", "id"],
    mono: true,
  },
};

/** Generic subject-key scan order when a table entry doesn't name its own. */
const AURA_SUBJECT_KEYS = [
  "id", "handle", "task", "identifier", "symbol", "name", "slug", "title",
  "file_path", "path", "query", "question", "goal", "objective", "message",
  "key", "zone", "scope", "agent", "session_id", "commit", "sha", "base",
  "reason", "target", "intent", "summary", "to", "repo",
];

/** Pull a display subject from a tool's input — first non-empty string among
 *  the entry's `subjectKeys`, falling back to a generic scan. */
function auraSubject(
  obj: Record<string, unknown>,
  keys: string[] | undefined,
): string | undefined {
  const order = keys && keys.length ? keys : AURA_SUBJECT_KEYS;
  for (const k of order) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return truncate(v.trim(), 100);
  }
  return undefined;
}

/** Humanized `ToolView` for an `aura-vcs` MCP tool from the flat registry.
 *  Returns null for any name not in the table so the caller falls through to
 *  the generic default. `norm` is the namespace-stripped, separator-free
 *  key. */
export function describeAuraMcpTool(
  norm: string,
  obj: Record<string, unknown>,
  metric: string | undefined,
): ToolView | null {
  const d = AURA_MCP_TOOLS[norm];
  if (!d) return null;
  const subject = auraSubject(obj, d.subjectKeys);
  return {
    verb: d.verb,
    tier: d.tier,
    subject,
    mono: d.mono ? !!subject : undefined,
    metric,
    glyph: d.glyph,
    accent: d.accent ?? (d.tier === "action" ? "accent" : "neutral"),
  };
}

// CLI brains drive the QuestionCard / PlanCard by invoking `aura ask-user`
// or `aura propose-plan` via their Bash tool. Those cards are the user-
// facing UX — the raw Bash tool card would be redundant noise. Returns
// true for Bash invocations whose command starts with one of these
// UX-routed verbs so we can skip rendering the generic tool card.
export function isAuraUxBash(name: string, input: unknown): boolean {
  const norm = name.toLowerCase().replace(/[-_]/g, "");
  if (norm !== "bash") return false;
  const obj =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const cmd = String(obj.command ?? "").trimStart();
  return /^aura\s+(ask-user|propose-plan)\b/.test(cmd);
}

/** Extract the first double-quoted argument from a shell command line
 *  while honouring backslash-escaped quotes inside the literal. Returns
 *  the string content (without the surrounding quotes) or null if no
 *  quoted argument is present. */
export function firstQuotedArg(cmd: string): string | null {
  const m = cmd.match(/"((?:\\.|[^"\\])*)"/);
  if (!m) return null;
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Friendly tool-card view for `aura <subcommand> ...` shelled out by a
 *  CLI brain. Returns null for non-aura commands (so the caller falls
 *  through to the generic Running view) and for the QuestionCard/PlanCard
 *  routed verbs (those are already hidden by `isAuraUxBash`).
 *
 *  Each known subcommand maps to a desktop-friendly verb + the natural-
 *  language goal as the subject. Raw INPUT JSON is suppressed in the
 *  expanded card via `hideRawInput: true` — the goal text and command
 *  description carry all the useful detail, the raw shell envelope is
 *  noise to a non-CLI user. */
export function describeAuraBash(
  cmd: string,
  desc: string | undefined,
  metric: string | undefined,
): ToolView | null {
  const trimmed = cmd.trimStart();
  // `s` flag — subagent prompts embed real newlines (numbered task lists,
  // multi-paragraph context). Without dotAll, `(.*)` stops at the first
  // `\n` and the regex fails end-to-end, dropping us into the generic
  // "Running" view with a raw INPUT pane.
  const m = trimmed.match(/^aura\s+([a-zA-Z][a-zA-Z0-9-]*)\b\s*([\s\S]*)$/);
  if (!m) return null;
  const sub = m[1].toLowerCase();
  const rest = m[2].trim();
  const goal = firstQuotedArg(trimmed);
  const restNoQuotes = goal ? rest.replace(/"[^"]*"/, "").trim() : rest;
  const baseAction = (
    verb: string,
    subject?: string,
    body?: string,
    glyph: ToolView["glyph"] = "generic",
    accent: ToolView["accent"] = "neutral",
  ): ToolView => ({
    verb,
    tier: "action",
    subject,
    body: body ?? desc,
    metric,
    hideRawInput: true,
    glyph,
    accent,
  });
  const baseThinking = (
    verb: string,
    subject?: string,
    body?: string,
    glyph: ToolView["glyph"] = "generic",
    accent: ToolView["accent"] = "neutral",
  ): ToolView => ({
    verb,
    tier: "thinking",
    subject,
    body: body ?? desc,
    metric,
    hideRawInput: true,
    glyph,
    accent,
  });
  switch (sub) {
    case "plan":
      return baseAction(
        "Aura is planning",
        goal ?? (rest || undefined),
        undefined,
        "plan",
        "accent",
      );
    case "ask":
      return baseThinking(
        "Aura is searching",
        goal ?? (rest || undefined),
        undefined,
        "search",
      );
    case "prove":
      return baseThinking(
        "Aura is proving",
        goal ?? (rest || undefined),
        undefined,
        "review",
      );
    case "status":
      return baseThinking(
        "Aura status",
        restNoQuotes || undefined,
        undefined,
        "review",
      );
    case "doctor":
      return baseThinking("Aura health check", undefined, undefined, "review");
    case "snapshot":
      return baseAction(
        "Saving a point",
        basename(restNoQuotes) || restNoQuotes || undefined,
        undefined,
        "write",
        "accent",
      );
    case "log-intent":
    case "logintent":
      return baseAction(
        "Recording the reason",
        goal ?? truncate(rest, 80),
        undefined,
        "write",
        "accent",
      );
    case "rewind":
      return baseAction(
        "Bringing back",
        restNoQuotes || undefined,
        undefined,
        "edit",
        "amber",
      );
    case "pr-review":
    case "prreview":
      return baseThinking(
        "Reviewing branch",
        restNoQuotes || "current branch",
        undefined,
        "review",
      );
    case "msg": {
      const action = restNoQuotes.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
      if (action === "send")
        return baseAction(
          "Messaging team",
          goal ?? truncate(rest, 80),
          undefined,
          "dispatch",
          "accent",
        );
      if (action === "list")
        return baseThinking(
          "Reading team messages",
          undefined,
          undefined,
          "dispatch",
        );
      return baseAction(
        "Team message",
        restNoQuotes || undefined,
        undefined,
        "dispatch",
        "accent",
      );
    }
    case "subagent": {
      const action = restNoQuotes.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
      if (action === "monitor") {
        const id = restNoQuotes.split(/\s+/)[1] ?? "";
        return baseThinking(
          "Watching subagent",
          id ? `task #${id}` : undefined,
          undefined,
          "dispatch",
        );
      }
      if (action === "spawn") {
        // `aura subagent spawn <provider> "<prompt>"` — render as a
        // dispatched-agent card. Provider is the second positional token;
        // the natural-language prompt is the first quoted arg.
        const provider = restNoQuotes.split(/\s+/)[1] ?? "agent";
        const subject =
          desc?.trim() ||
          (goal ? truncate(goal.split(/\r?\n/)[0] ?? goal, 90) : undefined);
        const body = goal ? truncate(goal, 280) : undefined;
        return {
          verb: `Dispatching ${provider}`,
          tier: "action",
          subject,
          body,
          metric,
          hideRawInput: true,
          glyph: "dispatch",
          accent: "accent",
        };
      }
      return baseAction(
        "Subagent",
        restNoQuotes || undefined,
        undefined,
        "dispatch",
        "accent",
      );
    }
    case "a2a-task":
    case "a2atask": {
      const action = restNoQuotes.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
      const verb =
        action === "create"
          ? "Creating task"
          : action === "list"
            ? "Listing tasks"
            : action === "get"
              ? "Reading task"
              : action === "patch"
                ? "Updating task"
                : action === "search"
                  ? "Searching tasks"
                  : action === "close"
                    ? "Closing tasks"
                    : "Task orchestration";
      const isThinking =
        action === "list" || action === "get" || action === "search";
      return isThinking
        ? baseThinking(verb, goal ?? undefined, undefined, "task")
        : baseAction(verb, goal ?? undefined, undefined, "task", "accent");
    }
    case "handover":
      return baseAction(
        "Handing over",
        restNoQuotes || undefined,
        undefined,
        "dispatch",
        "accent",
      );
    case "episodic-recall":
    case "episodicrecall":
      return baseThinking(
        "Recalling episodes",
        goal ?? undefined,
        undefined,
        "search",
      );
    case "session":
      return baseThinking(
        "Aura session",
        restNoQuotes || undefined,
        undefined,
        "generic",
      );
    case "memory":
      return baseAction(
        "Aura memory",
        restNoQuotes || undefined,
        undefined,
        "write",
        "accent",
      );
    case "live":
      return baseThinking(
        "Cross-branch impacts",
        restNoQuotes || undefined,
        undefined,
        "review",
      );
    case "sentinel":
      return baseAction(
        "Sentinel",
        restNoQuotes || undefined,
        undefined,
        "dispatch",
        "accent",
      );
    case "orchestrate":
      return baseAction(
        "Orchestrating",
        goal ?? (restNoQuotes || undefined),
        undefined,
        "dispatch",
        "accent",
      );
    default:
      // Unknown aura subcommand — still hide the raw bash envelope, but
      // surface the verb so the user knows what aura is doing.
      return baseAction(
        `Aura ${sub}`,
        restNoQuotes ? truncate(restNoQuotes, 80) : undefined,
        undefined,
        "generic",
        "neutral",
      );
  }
}

// Shell commands that don't change the world — render as thinking tier.
export function isReadOnlyBash(cmd: string): boolean {
  const head = cmd.trimStart().split(/[\s|;&]/, 1)[0]?.toLowerCase() ?? "";
  return [
    "cat", "head", "tail", "ls", "wc", "find", "grep", "rg", "fd",
    "echo", "pwd", "which", "command", "type", "stat", "file",
    "git", "test", "[", "[[", "true", "false",
  ].includes(head);
}

export function basename(path: string): string {
  if (!path) return "";
  const last = path.split("/").filter(Boolean).pop();
  return last || path;
}

/** Raster/vector image extensions the chat can render inline. A read whose
 *  target matches gets an `imagePath` on its `ToolView`, so the card shows the
 *  actual picture instead of a bare filename row. */
const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

/** True when `path` points at an image we can preview. Reads the extension
 *  after stripping any `?query`/`#frag` tail; case-insensitive. */
export function isImagePath(path: string): boolean {
  if (!path) return false;
  const clean = path.split(/[?#]/)[0] ?? path;
  const dot = clean.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTS.has(clean.slice(dot + 1).toLowerCase());
}

// `ask_user` and its Claude-SDK PascalCase alias `AskUserQuestion` are
// the same intent: pause and ask the human via a QuestionCard. The
// brain normalizes them on the backend, the renderer treats them as
// one here so the generic ToolCard never double-renders next to the
// QuestionCard.
export function isAskUserTool(name: string): boolean {
  const n = name.toLowerCase().replace(/[-_]/g, "");
  return n === "askuser" || n === "askuserquestion" || n === "ask";
}

export function prettyToolName(name: string): string {
  // PascalCase or snake_case → Title Case words.
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

export function smartSummary(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "";
  // Prefer a string-valued field for display.
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0 && v.length < 200) {
      return truncate(v, 100);
    }
  }
  return truncate(safeStringify(obj), 100);
}

/** Turn a raw input key (`repo_root`, `dryRun`, `agent_assignee`) into a
 *  plain-language label ("Repo root", "Dry run", "Agent assignee"). */
export function humanizeKey(k: string): string {
  const s = k
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!s) return k;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Render a tool's raw input object as humanized `{label, value}` rows so the
 *  expanded card can show the inputs as plain rows instead of a JSON wall.
 *  Long values are truncated, arrays/objects condensed; capped so it stays
 *  compact. Returns `undefined` when there's nothing worth showing. */
export function humanizeFields(
  obj: Record<string, unknown>,
): ToolField[] | undefined {
  const fields: ToolField[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    let value: string;
    if (typeof v === "string") value = truncate(v, 220);
    else if (typeof v === "number" || typeof v === "boolean") value = String(v);
    else if (Array.isArray(v)) {
      const scalars = v
        .map((x) =>
          typeof x === "string" || typeof x === "number" || typeof x === "boolean"
            ? String(x)
            : "",
        )
        .filter(Boolean);
      value =
        scalars.length === v.length && scalars.length > 0
          ? truncate(scalars.join(", "), 220)
          : `${v.length} item${v.length === 1 ? "" : "s"}`;
    } else if (typeof v === "object") {
      value = truncate(smartSummary(v as Record<string, unknown>), 220);
    } else continue;
    if (!value) continue;
    fields.push({ label: humanizeKey(k), value });
    if (fields.length >= 8) break;
  }
  return fields.length ? fields : undefined;
}

export function resultMetric(
  name: string,
  result?: ToolResult,
): string | undefined {
  if (!result) return undefined;
  if (result.is_error) {
    const first = result.content.split("\n")[0] ?? "";
    return truncate(first, 60);
  }
  const norm = stripMcpNamespace(name).toLowerCase().replace(/[-_]/g, "");
  // Bash → exit + line count.
  if (norm === "bash") {
    const lines = countLines(result.content);
    return lines > 0 ? `${lines} ${lines === 1 ? "line" : "lines"}` : "no output";
  }
  // Read/Write/Edit/Notebook → line count.
  if (
    norm === "read" ||
    norm === "readfile" ||
    norm === "write" ||
    norm === "writefile" ||
    norm === "edit" ||
    norm === "editfile" ||
    norm === "multiedit" ||
    norm === "notebookedit"
  ) {
    const lines = countLines(result.content);
    if (lines === 0) return undefined;
    return `${lines} ${lines === 1 ? "line" : "lines"}`;
  }
  // Glob/Grep/Search → match count from result content if it looks countable.
  if (norm === "glob" || norm === "globsearch" || norm === "grep" || norm === "search") {
    const lines = countLines(result.content);
    return lines > 0 ? `${lines} ${lines === 1 ? "match" : "matches"}` : "no matches";
  }
  // Prove → proven / gaps, sniffed from the report text.
  if (norm === "prove" || norm === "auraprove") {
    const c = result.content.toLowerCase();
    if (c.includes("proven") || c.includes("verified") || c.includes("✓")) return "proven";
    if (c.includes("gap") || c.includes("missing")) return "gaps found";
    return undefined;
  }
  // Review → finding count parsed from the JSON report (graceful when the
  // 6k-truncated body isn't valid JSON: falls back to the ✓/✗ chip).
  if (norm === "review" || norm === "auraprreview" || norm === "aurareview") {
    const n = countReviewFindings(result.content);
    if (n === null) return undefined;
    return n === 0 ? "clean" : `${n} ${n === 1 ? "finding" : "findings"}`;
  }
  // Rewind → it either reverted or errored (errors handled above).
  if (norm === "rewind" || norm === "aurarewind") return "reverted";
  return undefined;
}

/** Sum the known finding arrays in a pr-review --json report. Returns
 *  null if the content isn't parseable JSON (e.g. truncated). */
export function countReviewFindings(content: string): number | null {
  let j: unknown;
  try {
    j = JSON.parse(content);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  let n = 0;
  for (const k of [
    "invariant_violations",
    "violations",
    "findings",
    "security",
    "security_findings",
    "unverified",
    "unverified_claims",
  ]) {
    const v = o[k];
    if (Array.isArray(v)) n += v.length;
  }
  return n;
}

export function countLines(s: string): number {
  if (!s) return 0;
  // Don't count a single trailing newline as an empty line.
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function firstLine(s: string): string {
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ── Diff builders ────────────────────────────────────────────────────────
//
// Edit/Write tools carry the literal text the model wants to change. Rather
// than dumping that as opaque INPUT JSON, the card renders a minimal unified
// diff: removed lines prefixed "-", added lines prefixed "+". These keep the
// header (`@@`) implicit — the card already shows the file basename as the
// subject — and cap the total at MAX_DIFF_LINES so a 2000-line Write doesn't
// flood the surface.

/** Cap a built diff at MAX_DIFF_LINES, replacing the overflow with a single
 *  "… N more lines" tail so the card stays scannable. */
function capDiff(lines: string[]): string {
  if (lines.length <= MAX_DIFF_LINES) return lines.join("\n");
  const head = lines.slice(0, MAX_DIFF_LINES);
  const remaining = lines.length - MAX_DIFF_LINES;
  head.push(`… ${remaining} more line${remaining === 1 ? "" : "s"}`);
  return head.join("\n");
}

/** Edit tool → one hunk: old_string lines removed, new_string lines added.
 *  Returns undefined when neither side carries text (nothing to diff). */
export function buildEditDiff(
  oldVal: unknown,
  newVal: unknown,
): string | undefined {
  const oldStr = oldVal === undefined || oldVal === null ? "" : String(oldVal);
  const newStr = newVal === undefined || newVal === null ? "" : String(newVal);
  if (!oldStr && !newStr) return undefined;
  const lines = editHunk(oldStr, newStr);
  if (lines.length === 0) return undefined;
  return capDiff(lines);
}

/** MultiEdit tool → concatenate one hunk per edit, separated by a blank
 *  line, then cap the whole thing. */
export function buildMultiEditDiff(edits: unknown): string | undefined {
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  const all: string[] = [];
  for (const e of edits) {
    const o = e && typeof e === "object" ? (e as Record<string, unknown>) : {};
    const oldStr = String(o.old_string ?? o.oldText ?? o.old ?? "");
    const newStr = String(o.new_string ?? o.newText ?? o.new ?? "");
    if (!oldStr && !newStr) continue;
    const hunk = editHunk(oldStr, newStr);
    if (hunk.length === 0) continue;
    if (all.length > 0) all.push("");
    all.push(...hunk);
  }
  if (all.length === 0) return undefined;
  return capDiff(all);
}

/** Write tool → the whole new file rendered as added ("+") lines, since
 *  Write replaces the file wholesale and there's no prior text to diff. */
export function buildWriteDiff(content: string): string | undefined {
  if (!content) return undefined;
  const lines = content.split("\n").map((l) => `+${l}`);
  return capDiff(lines);
}

/** Build a single removed-then-added hunk from old/new text blocks. */
function editHunk(oldStr: string, newStr: string): string[] {
  const out: string[] = [];
  if (oldStr) {
    for (const l of oldStr.split("\n")) out.push(`-${l}`);
  }
  if (newStr) {
    for (const l of newStr.split("\n")) out.push(`+${l}`);
  }
  return out;
}
