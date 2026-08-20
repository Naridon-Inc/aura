// Chat-first sweep — when the user types `/search`, `/zones`, `/team`,
// `/taste`, `/orchestrate`, etc. into the Manager composer, we intercept
// the submit and run the command client-side. The result appears as a local system bubble in
// the chat timeline (ephemeral; not persisted to session.chat).
//
// Anything not handled here falls through to the brain as a normal
// message. That keeps `/plan` etc. discoverable while letting power
// users invoke shell-style verbs without leaving the chat.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "./api";
import type { LoopTask, ManagerSummary, StreamEvent, StreamExitInfo } from "./api";
import { fetchManagerList } from "./managerCache";
import { fetchReadyView } from "./loopCache";
import { refreshSessions } from "./sessionsCache";
import { resolveAgentId } from "./agents";
import { managerCommandHelp } from "./managerCommands";
import { findClaudeCommand, hasPrimed, primeClaudeCommands } from "./claudeCommands";
import { buildPrSkillPrompt, getPrSkill, PR_SKILLS } from "./prSkills";
import { launchWorkspace } from "./workspaceCreateStore";
import { placeForNewWork } from "./ambientSession";
import { relativeAgeFromSecs } from "./relativeTime";

/** One resumable conversation in a `/resume` picker. */
export type SlashResumeRow = {
  /** Row identity / React key. For a native Aura chat this is the manager
   *  session id (opened directly); for a cross-agent row (`agentId` set) it's
   *  a synthetic `claude:<id>` key — the real id to import lives in
   *  `agentSessionId`. */
  id: string;
  /** Human title (the session's objective, or "Untitled chat"). */
  title: string;
  /** Quiet second line — progress + when it was last touched. May be empty. */
  subtitle: string;
  /** Where the row came from, so the picker can label it plainly:
   *  `"aura"` = a native Aura chat (reopened directly); `"claude-code"` = a
   *  Claude Code session you authored in this project (imported on pick). An
   *  Aura chat can use several coding tools over its life — this only names the
   *  row's *origin*, not every tool it ever touched. */
  kind: "aura" | "claude-code";
  /** Set for a cross-agent row: the agent that authored the session
   *  ("claude"). The row wears that agent's mark and is imported into a fresh
   *  native chat via `manager_import_agent_session` on pick, instead of being
   *  opened directly. Absent = a native Aura chat. */
  agentId?: string;
  /** The agent's own session id (e.g. Claude Code's `session_id`) passed to
   *  the import. Only present alongside `agentId`. */
  agentSessionId?: string;
};

/** Structured payload for an *action* slash command whose output is a control
 *  the user acts on (pick a thing → it happens), not informational text. These
 *  render as a live interactive block in the chat and — unlike informational
 *  output (`/status`, `/team`) — are NOT persisted to history: they're a
 *  transient affordance, like opening a menu, not conversation content. */
export type SlashInteractive = {
  kind: "resume";
  /** Past conversations in this workspace, newest first; clicking one resumes it. */
  sessions: SlashResumeRow[];
};

export type ChatSlashResult = {
  /** True when this composer message was handled locally — caller skips
   *  the brain call. */
  handled: boolean;
  /** Human-readable output rendered as a plain chat message (markdown). Always
   *  set when a command is handled. Slash results render like any normal
   *  reply — NO bespoke card/box component. */
  output?: string;
  /** Set instead of `output` for an *action* command (`/resume`): a live,
   *  clickable control rendered in the chat rather than a markdown body. The
   *  caller renders the interactive block and does NOT persist it. */
  interactive?: SlashInteractive;
  /** Severity tinting for the system bubble. */
  tone?: "info" | "ok" | "warn";
  /** Parity W8 — when set on a NON-handled result, the caller sends THIS
   *  text to the brain instead of the user's raw message. Lets a verb like
   *  `/pr describe` expand into a full skill prompt while the timeline still
   *  shows what the user typed. */
  forwardText?: string;
};

type Ctx = {
  repoRoot: string;
  /** The conversation the user is typing in. `/resume` uses it to drop the
   *  current chat from the list (you can't "resume" the one you're in). */
  sessionId?: string | null;
};

/** Returns null when `msg` is not a slash command handled here. The
 *  caller should forward to the brain in that case. */
export async function handleChatSlash(
  msg: string,
  ctx: Ctx,
): Promise<ChatSlashResult | null> {
  const trimmed = msg.trim();

  // `@<agent> /<command>` — route the slash command to ONE agent's own CLI
  // (e.g. `@cc /resume` continues your last Claude Code session). Detected
  // before the bare-slash path because these messages start with `@`.
  const mention = parseAgentMention(trimmed);
  if (mention) {
    return runAgentMention(ctx.repoRoot, mention);
  }

  if (!trimmed.startsWith("/")) return null;

  const [verb, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (verb.toLowerCase()) {
    case "help":
    case "commands":
    case "?":
      return { handled: true, tone: "info", output: managerCommandHelp() };
    case "status":
      return runStatus(ctx.repoRoot);
    case "capture":
    case "recording":
      return runCapture(ctx.repoRoot, rest);
    case "doctor":
    case "health":
      return runCli(ctx.repoRoot, ["doctor"], "/doctor");
    case "resume":
    case "sessions":
    case "history":
      return runResume(ctx.repoRoot, ctx.sessionId ?? null);
    case "model":
    case "brain":
      // The model/brain picker lives in the chat header. Pop it open (the
      // optional query pre-narrows it) and leave a breadcrumb.
      window.dispatchEvent(
        new CustomEvent("aura:composer:open-brain-picker", {
          detail: { query: arg || undefined },
        }),
      );
      return {
        handled: true,
        tone: "info",
        output:
          "Opened the model picker. Choose which AI answers your next message. The pick sticks until you change it.",
      };
    case "agents":
    case "agent":
      return runAgents();
    case "diff":
      return runDiff(ctx.repoRoot, arg);
    case "review":
    case "pr-review":
      return runReview(ctx.repoRoot, rest);
    case "prove":
      return runProve(ctx.repoRoot, arg);
    case "rewind":
      return runRewind(ctx.repoRoot, rest);
    case "search":
      return runSearch(ctx.repoRoot, arg);
    case "zone":
    case "zones":
      return runZones(ctx.repoRoot, rest);
    case "team":
      return runTeam(ctx.repoRoot, rest);
    case "taste":
      return runTaste(ctx.repoRoot, rest);
    case "orch":
    case "orchestrate":
      return runOrchestrate(ctx.repoRoot, rest);
    case "loop":
      return runLoop(ctx.repoRoot, rest);
    case "pr":
      return runPr(ctx.repoRoot, rest);
    case "launch":
      return runLaunch(ctx.repoRoot, rest);
    default: {
      // Not a native Aura verb. It may be one of Claude Code's OWN custom
      // slash commands (`.claude/commands/<verb>.md`). If so, run it on
      // Claude's CLI regardless of which brain is selected here, so the user
      // can reach their Claude commands from this chat. Otherwise fall through
      // to the active brain as ordinary prose.
      let claudeCmd = findClaudeCommand(ctx.repoRoot, verb);
      if (!claudeCmd && !hasPrimed(ctx.repoRoot)) {
        // Never scanned this repo (the composer never primed it) — prime once,
        // then re-check before giving up to the brain. A repo already primed to
        // empty won't re-scan here on every unmatched verb.
        await primeClaudeCommands(ctx.repoRoot);
        claudeCmd = findClaudeCommand(ctx.repoRoot, verb);
      }
      if (claudeCmd) {
        return runOnAgentCli(ctx.repoRoot, "claude", "claude", claudeCmd.name, arg);
      }
      return null;
    }
  }
}

// ─── @<agent> /<command> — route a slash command to one agent's CLI ──────

type AgentMention = {
  /** Canonical registry id the handle resolved to (e.g. `claude`). */
  agentId: string;
  /** The raw handle the user typed (e.g. `cc`) — for the breadcrumb. */
  handle: string;
  /** Command verb without the leading slash (e.g. `resume`). */
  command: string;
  /** Anything the user typed after the command verb. */
  rest: string;
};

/** Parse `@<agent> /<command> [args]`. Returns null when the message isn't
 *  an agent mention, so the caller falls through to the normal paths. The
 *  `@handle` and `/command` are both required; a bare `@handle` with no
 *  slash is treated as ordinary prose (it falls through to the brain). */
function parseAgentMention(trimmed: string): AgentMention | null {
  // @handle  /command  rest…   (whitespace between handle and slash)
  const m = trimmed.match(/^@([A-Za-z0-9_-]+)\s+\/([A-Za-z0-9_-]+)\s*(.*)$/s);
  if (!m) return null;
  const handle = m[1];
  return {
    agentId: resolveAgentId(handle),
    handle,
    command: m[2].toLowerCase(),
    rest: (m[3] || "").trim(),
  };
}

/** Slash commands we can faithfully express as a ONE-SHOT agent CLI run.
 *  `resume`/`continue` map onto the CLI's real resume capability (claude
 *  `--resume`/`--continue`, wired in `build_invocation` via the
 *  `resumeSession` arg). Everything else here is sent as plain prompt text.
 *  REPL-only Claude slashes (`/compact`, `/clear`, `/model`) have no
 *  one-shot form, so we don't pretend to run them. */
function mentionIsContinue(command: string): boolean {
  return command === "resume" || command === "continue";
}

/** Run one agent's slash command on its own CLI and collect the streamed
 *  output into a single system bubble. Stays entirely client-side: we drive
 *  the existing `agent_stream_send` Tauri path (same one the Composer uses),
 *  subscribe to its event + done topics, assemble the assistant text, and
 *  unsubscribe. No ManagerChatView hook needed — the result renders as a
 *  normal system bubble via the returned `output`. */
async function runAgentMention(
  repoRoot: string,
  mention: AgentMention,
): Promise<ChatSlashResult> {
  return runOnAgentCli(repoRoot, mention.agentId, mention.handle, mention.command, mention.rest);
}

/** Run `/command rest` on `agentId`'s own CLI and collect the streamed output
 *  into one plain message. Shared by the `@<agent> /cmd` mention path and the
 *  Claude-custom-command fall-through (which always targets `claude`). */
async function runOnAgentCli(
  repoRoot: string,
  agentId: string,
  handle: string,
  command: string,
  rest: string,
): Promise<ChatSlashResult> {
  // The agent must actually be installed. `agentDiscover` is the same probe
  // the picker uses, so an uninstalled tool produces a clear message instead
  // of a spawn failure deep in the backend.
  let installed = false;
  try {
    const discovered = await api.agentDiscover();
    installed = discovered.some((a) => a.id === agentId && a.available);
  } catch {
    installed = false;
  }
  if (!installed) {
    return {
      handled: true,
      tone: "warn",
      output:
        `Can't reach **${handle}**. No \`${agentId}\` assistant is installed and on your PATH. ` +
        "Run `/agents` to see what's available here.",
    };
  }

  if (!repoRoot) {
    return {
      handled: true,
      tone: "warn",
      output:
        `\`@${handle} /${command}\` needs an open project so the assistant runs in the right folder. ` +
        "Open a repo first, then try again.",
    };
  }

  // `resume`/`continue` → pick the agent's previous session back up.
  // `agent_stream_send` maps a non-null `resumeSession` onto the CLI's real
  // resume flag (`claude --resume <id>`, wired in `build_invocation`). We
  // resolve the real, most-recent session id for this folder rather than a
  // sentinel, since the CLI needs a concrete id.
  const isContinue = mentionIsContinue(command);
  let resumeSession: string | null = null;
  if (isContinue) {
    const lastSession = await mostRecentSessionId(agentId, repoRoot);
    if (!lastSession) {
      return {
        handled: true,
        tone: "info",
        output:
          `No earlier **${handle}** session found in this project. There's nothing to resume yet. ` +
          "Start one from the agent rail, then `@" +
          handle +
          " /resume` will pick it back up.",
      };
    }
    resumeSession = lastSession;
  }
  // For non-resume verbs we send the slash line itself as the prompt so the
  // agent gets a clear, literal instruction (it parses its own slashes).
  const prompt = isContinue
    ? rest || "Continue from where we left off."
    : `/${command}${rest ? " " + rest : ""}`;

  let handle_: { topic: string; done_topic: string };
  try {
    handle_ = await api.agentStreamSend(
      agentId,
      repoRoot,
      prompt,
      resumeSession,
    );
  } catch (e) {
    return {
      handled: true,
      tone: "warn",
      output: `\`@${handle} /${command}\` couldn't start: ${errorMsg(e)}`,
    };
  }

  let collected: string;
  let ok: boolean;
  try {
    const result = await collectAgentStream(handle_.topic, handle_.done_topic);
    collected = result.text;
    ok = result.ok;
  } catch (e) {
    return {
      handled: true,
      tone: "warn",
      output: `\`@${handle} /${command}\` failed while running: ${errorMsg(e)}`,
    };
  }

  const label = `@${handle} /${command}`;
  const body = collected.trim();
  if (!body) {
    return {
      handled: true,
      tone: ok ? "info" : "warn",
      output: ok
        ? `**${label}**. Done (the assistant returned no text this time).`
        : `**${label}**. The assistant exited without producing output.`,
    };
  }
  return {
    handled: true,
    tone: ok ? "info" : "warn",
    output: `**${label}**\n\n${softWrap(truncate(body, 8000))}`,
  };
}

/** The most recent on-disk session id for `agentId` in `repoRoot`, or null
 *  when none exists / the agent exposes no session list. Claude Code is the
 *  one with a real transcript index (`claude_list_sessions`, sorted
 *  newest-first); other CLIs don't surface a resumable id here, so a `/resume`
 *  on them reports "nothing to resume" rather than guessing. */
async function mostRecentSessionId(
  agentId: string,
  repoRoot: string,
): Promise<string | null> {
  if (agentId !== "claude") return null;
  try {
    const sessions = await refreshSessions(repoRoot);
    return sessions[0]?.session_id ?? null;
  } catch {
    return null;
  }
}

/** Subscribe to one agent-stream turn, assemble the human-readable text from
 *  its typed events, and resolve when the done sentinel fires. Tool calls and
 *  results are folded into short, plain lines so the bubble stays readable
 *  instead of a raw-JSON wall. */
function collectAgentStream(
  topic: string,
  doneTopic: string,
): Promise<{ text: string; ok: boolean }> {
  return new Promise((resolve, reject) => {
    const parts: string[] = [];
    let resolved = false;
    let unEvents: UnlistenFn | null = null;
    let unDone: UnlistenFn | null = null;
    // Hard ceiling so a hung CLI can't pin the bubble open forever.
    const timeout = setTimeout(() => finish(true, false), 180_000);

    function cleanup() {
      clearTimeout(timeout);
      if (unEvents) unEvents();
      if (unDone) unDone();
    }

    function finish(timedOut: boolean, ok: boolean) {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (timedOut) {
        parts.push(
          "\n_(stopped waiting after 3 minutes. The assistant may still be working)_",
        );
      }
      resolve({ text: parts.join(""), ok });
    }

    listen<StreamEvent>(topic, (e) => {
      const ev = e.payload;
      switch (ev.kind) {
        case "assistant_text":
          parts.push(ev.text);
          break;
        case "tool_use":
          parts.push(`\n\n_→ ${ev.name}_\n`);
          break;
        case "tool_result":
          if (ev.is_error) {
            parts.push(`\n_(a tool reported an error)_\n`);
          }
          break;
        case "result":
          if (ev.message && parts.length === 0) {
            parts.push(ev.message);
          }
          break;
        case "raw_error":
          parts.push(`\n_(error: ${ev.message})_\n`);
          break;
        default:
          break;
      }
    })
      .then((un) => {
        if (resolved) {
          un();
          return;
        }
        unEvents = un;
      })
      .catch(reject);

    listen<StreamExitInfo>(doneTopic, (e) => {
      finish(false, e.payload.exit_code === 0);
    })
      .then((un) => {
        if (resolved) {
          un();
          return;
        }
        unDone = un;
      })
      .catch(reject);
  });
}

// ─── /status — the whole picture, as a plain formatted message ───────────
//
// `/status` used to be a small "is my work safe?" card. Aura got bigger, so
// this is now a comprehensive, well-formatted message (no card): which coding
// assistants are connected and working, your conversations here, how many
// "why" notes have been logged today, plus the engine / recording / protection
// state in plain language. Every number is pulled from a real, already-shipped
// api — each probe is independent and failure-tolerant, so a missing one just
// drops its line instead of failing the whole command.

/** Terse age ("just now" / "5m ago" / "3h ago" / "2d ago") from a unix-seconds
 *  timestamp. Empty for a missing/zero stamp so the caller omits the time. */
function statusRelTime(unixSecs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  // Which this file already imported, and already used, 250 lines below.
  return relativeAgeFromSecs(unixSecs);
}

/** The short "recording / protection / engine" safety lines — reused by
 *  `/capture` after it flips recording so its bubble reflects the new state.
 *  Plain language only: no "strict mode", "blockstore", or "AST" on the
 *  surface. */
async function buildSafetyLines(repoRoot: string): Promise<string[]> {
  const [status, strict, capture] = await Promise.all([
    api.auraStatus().catch(() => null),
    api.auraStrictMode().catch(() => null),
    repoRoot ? api.captureStatus(repoRoot).catch(() => null) : Promise.resolve(null),
  ]);

  // No capture probe (no repo / call failed) → assume git-capable so we don't
  // wrongly tell the user "this folder can't record".
  const recordingEnabled = !!capture?.enabled;
  const isGit = capture ? capture.is_git : true;
  // "as you work" was wrong: capture is a set of git hooks, so it runs when
  // you commit. Told that the record is being kept continuously, a person
  // reasonably stops thinking about the hours of uncommitted work — which is
  // the exact stretch of time the record does not cover.
  const recording = recordingEnabled
    ? "On. Each commit gets saved with its reason"
    : isGit
      ? "Off. Your commits aren't being recorded yet"
      : "This folder isn't a project yet, so there's nothing to record";

  const mode = strict?.mode ?? "off";
  const protection =
    mode === "locked"
      ? "Locked on. Only you (with the passcode) can switch it off"
      : mode === "on"
        ? "On. Risky deletions get a second look before they land"
        : "Off. Assistants can change anything without a check";

  const engine = status?.initialized
    ? `Ready${status.block_count != null ? ` · remembering ${status.block_count} pieces of your code` : ""}`
    : "Not set up on this machine yet";

  const lines = [
    `- **Recording your work:** ${recording}`,
    `- **Protection:** ${protection}`,
    `- **Aura engine:** ${engine}`,
  ];
  if (!recordingEnabled && isGit) {
    lines.push("", "_Turn recording on with `/capture on`._");
  }
  return lines;
}

/** Build the comprehensive `/status` message. Each section is gathered from a
 *  real api and degrades on its own — a failed probe drops its block rather
 *  than failing the command. */
async function buildStatusReport(repoRoot: string): Promise<string> {
  const [agents, sessions, intentToday, safetyLines] = await Promise.all([
    api.agentDiscover().catch(() => [] as Awaited<ReturnType<typeof api.agentDiscover>>),
    repoRoot
      ? fetchManagerList(repoRoot).catch(() => [] as ManagerSummary[])
      : Promise.resolve([] as ManagerSummary[]),
    repoRoot ? api.auraCountIntentsToday(repoRoot).catch(() => null) : Promise.resolve(null),
    buildSafetyLines(repoRoot),
  ]);

  const sections: string[] = ["## Where things stand", ""];

  // ── Coding assistants connected / working ──────────────────────────────
  const ready = agents.filter((a) => a.available);
  // A session is "working" while it's actively running (the brain or an agent
  // is mid-turn). `manager_list` is workspace-scoped, so this counts only
  // chats in THIS project.
  const working = sessions.filter(
    (s) => s.status === "running" || s.status === "awaiting_approval",
  );
  sections.push("**Coding assistants**");
  if (agents.length === 0) {
    sections.push(
      "",
      "_None found yet. Install one (Claude Code, Gemini CLI, Codex…) and it shows up here automatically._",
    );
  } else {
    sections.push("");
    for (const a of agents) {
      const ver = a.version ? ` · ${a.version}` : "";
      const mark = a.available ? "connected" : "not installed";
      sections.push(`- **${a.label}** · ${mark}${ver}`);
    }
    sections.push(
      "",
      working.length > 0
        ? `_${ready.length} connected · ${working.length} working right now in this project._`
        : `_${ready.length} connected · none mid-task right now._`,
    );
  }
  sections.push("");

  // ── Your conversations here (sessions) ─────────────────────────────────
  sections.push("**Your conversations here**");
  if (sessions.length === 0) {
    sections.push("", "_No conversations in this project yet._");
  } else {
    const newest = [...sessions].sort(
      (a, b) =>
        (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0),
    )[0];
    const when = statusRelTime(newest.updated_at || newest.created_at);
    const title = newest.objective?.trim() || "Untitled chat";
    sections.push(
      "",
      `- **${sessions.length}** in total`,
      `- Most recent: **${title}**${when ? ` (${when})` : ""}`,
    );
  }
  sections.push("");

  // ── Notes logged ("why" behind changes — intents, in plain words) ──────
  // Only show a real number; if the count probe failed, omit the line rather
  // than guess.
  if (typeof intentToday === "number") {
    sections.push(
      "**Notes on your changes**",
      "",
      intentToday > 0
        ? `- **${intentToday}** recorded today (the "why" behind what changed)`
        : "- None recorded yet today",
      "",
    );
  }

  // ── Engine / recording / protection (the safety read) ──────────────────
  sections.push("**Safety**", "", ...safetyLines);

  return sections.join("\n");
}

async function runStatus(repoRoot: string): Promise<ChatSlashResult> {
  try {
    const output = await buildStatusReport(repoRoot);
    return { handled: true, tone: "info", output };
  } catch {
    // Every probe failed — fall back to the raw CLI dump rather than showing
    // nothing.
    return runCli(repoRoot, ["status"], "/status");
  }
}

// ─── /resume — your past Aura conversations in this project ──────────────

/** List the workspace's past conversations as one-click Resume rows — both
 *  native Aura chats AND the Claude Code sessions you authored in this project,
 *  so you can pick an outside-agent thread back up inside Aura chat. Both
 *  sources are workspace-scoped (`manager_list` by the #293 leak fix;
 *  `claude_list_sessions` unions the main checkout + sibling worktrees but stays
 *  inside this project), so nothing from another project leaks in. The current
 *  conversation is dropped. A failure on either side is non-fatal — we show what
 *  we got; only a total failure pops the header history dropdown as a way back. */
async function runResume(
  repoRoot: string,
  currentSessionId: string | null,
): Promise<ChatSlashResult> {
  if (!repoRoot) {
    return {
      handled: true,
      tone: "warn",
      output: "Open a project first. Past conversations are listed per workspace.",
    };
  }

  const [nativeRes, claudeRes] = await Promise.allSettled([
    fetchManagerList(repoRoot),
    refreshSessions(repoRoot),
  ]);

  if (nativeRes.status === "rejected" && claudeRes.status === "rejected") {
    window.dispatchEvent(new CustomEvent("aura:manager:open-history"));
    return {
      handled: true,
      tone: "warn",
      output: `Couldn't list past conversations (${errorMsg(nativeRes.reason)}). Opened the history dropdown (the clock icon, top-right) instead.`,
    };
  }

  const nowSecs = Date.now() / 1000;
  // Both kinds collapse to one recency-sorted list. `ts` is unix seconds for
  // each (native: updated/created; Claude: file mtime) so they interleave
  // correctly — the newest thread wins regardless of which agent authored it.
  const candidates: { ts: number; row: SlashResumeRow }[] = [];

  if (nativeRes.status === "fulfilled") {
    for (const s of nativeRes.value) {
      if (s.id === currentSessionId) continue;
      const ts = s.updated_at || s.created_at || 0;
      const prog = s.task_count > 0 ? `${s.done_count}/${s.task_count} done` : "";
      const subtitle = [prog, resumeAgoLabel(ts, nowSecs)].filter(Boolean).join(" · ");
      candidates.push({
        ts,
        row: { id: s.id, title: s.objective?.trim() || "Untitled chat", subtitle, kind: "aura" },
      });
    }
  }

  if (claudeRes.status === "fulfilled") {
    for (const c of claudeRes.value) {
      const ts = c.mtime || 0;
      const title = c.last_prompt?.trim() || c.first_prompt?.trim() || "Claude Code session";
      const turns = c.turn_count > 0 ? `${c.turn_count} turns` : "";
      const subtitle = [turns, resumeAgoLabel(ts, nowSecs)].filter(Boolean).join(" · ");
      candidates.push({
        ts,
        row: {
          id: `claude:${c.session_id}`,
          title,
          subtitle,
          kind: "claude-code",
          agentId: "claude",
          agentSessionId: c.session_id,
        },
      });
    }
  }

  if (candidates.length === 0) {
    return {
      handled: true,
      tone: "info",
      output:
        "**No earlier conversations here yet.** This is your first chat in this project. Once you've had a few (here or in Claude Code), `/resume` lists them with a one-click way back.",
    };
  }

  // An action, not a readout — clickable rows that actually resume the thread.
  // Native rows reopen directly; a Claude Code row is imported into a fresh
  // native chat (transcript and all) on pick.
  const rows = candidates
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 8)
    .map((c) => c.row);

  return { handled: true, tone: "info", interactive: { kind: "resume", sessions: rows } };
}

/** "just now" / "3m ago" / "2h ago" / "5d ago" — the same quiet recency phrasing
 *  the question/plan cards use, kept local so `/resume` rows don't pull a dep. */
function resumeAgoLabel(tsSecs: number, nowSecs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromSecs(tsSecs, { now: nowSecs * 1000 });
}

// ─── /capture — turn change-recording on/off, then show status ───────────

async function runCapture(repoRoot: string, rest: string[]): Promise<ChatSlashResult> {
  const sub = (rest[0] || "status").toLowerCase();

  if (!repoRoot && (sub === "on" || sub === "off" || sub === "enable" || sub === "disable")) {
    return {
      handled: true,
      tone: "warn",
      output: "Open a project first. Recording is per-folder.",
    };
  }

  // Flip recording, then re-read the safety lines so the bubble reflects the
  // new state.
  const flip = async (
    run: () => Promise<{ status: number; stdout?: string; stderr?: string }>,
    okNote: string,
    failVerb: string,
  ): Promise<ChatSlashResult> => {
    try {
      const r = await run();
      const ok = r.status === 0;
      const lines = await buildSafetyLines(repoRoot);
      const note = ok
        ? okNote
        : `Couldn't ${failVerb}: ${(r.stderr || r.stdout || "").trim() || "unknown error"}`;
      return {
        handled: true,
        tone: ok ? "ok" : "warn",
        output: [note, "", ...lines].join("\n"),
      };
    } catch (e) {
      return { handled: true, tone: "warn", output: `/capture ${sub} failed: ${errorMsg(e)}` };
    }
  };

  if (sub === "on" || sub === "enable") {
    return flip(
      () => api.captureEnable(repoRoot),
      "**Recording is on.** From your next commit, Aura saves what changed and why.",
      "turn recording on",
    );
  }
  if (sub === "off" || sub === "disable") {
    return flip(
      () => api.captureDisable(repoRoot),
      // The on-message names the moment ("from your next commit"); this one said
      // "stop capturing changes", which reads as though something continuous was
      // being switched off. Both ends of one toggle should describe the same
      // mechanism.
      "**Recording is off.** Commits in this folder won't be recorded from now on.",
      "turn recording off",
    );
  }
  // Bare `/capture` (or `/capture status`) → just show the safety card.
  return runStatus(repoRoot);
}

// ─── /agents — coding assistants installed on this machine ───────────────

async function runAgents(): Promise<ChatSlashResult> {
  try {
    const discovered = await api.agentDiscover();
    if (discovered.length === 0) {
      return {
        handled: true,
        tone: "info",
        output:
          "**No coding assistants found.** Install one (Claude Code, Gemini CLI, Codex, …) and it'll show up here automatically.",
      };
    }
    const lines = discovered.map((a) => {
      const mark = a.available ? "ready" : "not installed";
      const ver = a.version ? ` · ${a.version}` : "";
      return `- **${a.label}** (\`${a.id}\`) · ${mark}${ver}`;
    });
    return {
      handled: true,
      tone: "info",
      output: [
        "**Installed assistants**",
        "",
        ...lines,
        "",
        "_Send a command straight to one with `@<id> /<command>`. E.g. `@cc /resume`._",
      ].join("\n"),
    };
  } catch (e) {
    return { handled: true, tone: "warn", output: `/agents failed: ${errorMsg(e)}` };
  }
}

// ─── /diff — plain-language view of what changed ─────────────────────────

async function runDiff(repoRoot: string, file: string): Promise<ChatSlashResult> {
  const args = file ? ["diff", file] : ["diff"];
  return runCli(repoRoot, args, file ? `/diff ${file}` : "/diff");
}

// ─── /review — Aura reads your changes for bugs + risky deletions ────────

async function runReview(repoRoot: string, rest: string[]): Promise<ChatSlashResult> {
  // /review            → pr-review against the default base
  // /review <base>     → pr-review against an explicit base branch
  const base = (rest[0] || "").trim();
  const args = base ? ["pr-review", "--base", base] : ["pr-review"];
  return runCli(repoRoot, args, base ? `/review ${base}` : "/review");
}

// ─── /prove — does the code really do what you set out to do? ────────────

async function runProve(repoRoot: string, text: string): Promise<ChatSlashResult> {
  if (!text) {
    return {
      handled: true,
      tone: "warn",
      output:
        'Usage: `/prove <what you built>`. Describe the goal in plain words, e.g. `/prove users can sign in with Google`.',
    };
  }
  return runCli(repoRoot, ["goals", "prove", text], `/prove ${text}`);
}

// ─── /rewind — roll one function back to its last safe version ───────────

async function runRewind(repoRoot: string, rest: string[]): Promise<ChatSlashResult> {
  const identifier = (rest[0] || "").trim();
  const filePath = (rest[1] || "").trim();
  if (!identifier || !filePath) {
    return {
      handled: true,
      tone: "warn",
      output:
        "Usage: `/rewind <function> <file>`. Rolls one function back to its last safe version, e.g. `/rewind calculate_tax src/billing.ts`.",
    };
  }
  return runCli(repoRoot, ["rewind", identifier, filePath], `/rewind ${identifier} ${filePath}`);
}

// ─── /pr — ask Aura to handle the PR, expanded into brain prompts ─────────

async function runPr(repoRoot: string, rest: string[]): Promise<ChatSlashResult> {
  // /pr                       → skill list
  // /pr <skill> [#N]          → expand the skill prompt and forward to brain
  const sub = (rest[0] || "").toLowerCase();
  if (!sub || sub === "help") {
    const lines = [
      "**/pr. PR copilot skills**",
      "",
      ...PR_SKILLS.map((s) => `- \`/pr ${s.id}\` · ${s.summary}`),
      "",
      "_Add `#<number>` to target an open PR: `/pr review #42`. Templates are_",
      "_overridable per-repo in `.aura/skills/pr/<skill>.md`._",
    ];
    return { handled: true, tone: "info", output: lines.join("\n") };
  }

  const skill = getPrSkill(sub);
  if (!skill) {
    return {
      handled: true,
      tone: "warn",
      output: `Unknown PR skill \`${sub}\`. Try: ${PR_SKILLS.map((s) => `\`${s.id}\``).join(", ")}.`,
    };
  }

  // Optional `#N` / `N` PR number anywhere in the remaining args.
  const numArg = rest.slice(1).find((a) => /^#?\d+$/.test(a));
  const prNumber = numArg ? parseInt(numArg.replace("#", ""), 10) : null;

  try {
    const prompt = await buildPrSkillPrompt(repoRoot, skill, { prNumber });
    // Not handled: the caller forwards `forwardText` to the brain — the
    // timeline shows the user's `/pr …` while the brain gets the full skill.
    return { handled: false, forwardText: prompt };
  } catch (e) {
    return { handled: true, tone: "warn", output: `/pr ${sub} failed: ${errorMsg(e)}` };
  }
}

// ─── /launch — worktree + agent fleet in one verb ────────────────────────

async function runLaunch(repoRoot: string, rest: string[]): Promise<ChatSlashResult> {
  // /launch <branch> <agent> [agent…]  → worktree off HEAD + agent fleet
  const branch = (rest[0] || "").trim();
  const agentIds = rest.slice(1).filter(Boolean);
  if (!branch || agentIds.length === 0) {
    return {
      handled: true,
      tone: "warn",
      output:
        "Usage: `/launch <branch> <agent> [agent…]`. Creates a parallel copy on `<branch>` and spawns each agent inside it. Example: `/launch feat/login claude gemini`.",
    };
  }
  try {
    const { manifest, worktreePath, errors } = await launchWorkspace({
      // Name the place the copy is asked for in. `/launch` typed into a chat
      // that is running on a machine means a copy on that machine, made over
      // there — not quietly cut out of this laptop's disk instead.
      machineId: placeForNewWork(repoRoot),
      repoRoot,
      branch,
      agents: agentIds.map((agentId) => ({ agentId })),
    });
    const lines = [
      `**/launch ${branch}**. Parallel copy ready at \`${worktreePath}\``,
      "",
      ...(manifest?.sessions ?? []).map(
        (s) => `- ${s.agent_id} ${s.resumed ? "(re-attached)" : "spawned"}`,
      ),
    ];
    if (errors.length > 0) {
      lines.push("", "**Failed to spawn:**", ...errors.map((e) => `- ${e}`));
    }
    lines.push("", "_Tabs are waiting in the new workspace. Switch over from the rail._");
    return {
      handled: true,
      tone: errors.length > 0 ? "warn" : "ok",
      output: lines.join("\n"),
    };
  } catch (e) {
    return { handled: true, tone: "warn", output: `/launch failed: ${errorMsg(e)}` };
  }
}

async function runSearch(repoRoot: string, query: string): Promise<ChatSlashResult> {
  if (!query) {
    return {
      handled: true,
      tone: "warn",
      output: "Usage: `/search <text>`. Finds matching code across the repo.",
    };
  }
  try {
    const r = await api.auraCli(repoRoot, ["search", query]);
    const body = r.stdout?.trim() || r.stderr?.trim() || "no matches";
    return {
      handled: true,
      tone: "info",
      output: `**/search ${query}**\n\n${softWrap(truncate(body, 4000))}`,
    };
  } catch (e) {
    return {
      handled: true,
      tone: "warn",
      output: `/search failed: ${errorMsg(e)}`,
    };
  }
}

const ZONES_EMPTY_LEARN = [
  "**Zone claims. None yet**",
  "",
  "Zones let teammates carve out short-lived ownership of files so two agents (or two humans) don't fight over the same lines.",
  "",
  "Try it:",
  "- `/zone claim src/auth.ts`. Claim a file while you edit it.",
  "- `/zone list`. See who's holding what.",
  "- `/zone release src/auth.ts`. Let go when you're done.",
  "",
  "Claims auto-expire after 30 min unless renewed.",
].join("\n");

async function runZones(repoRoot: string, rest: string[]): Promise<ChatSlashResult> {
  // `/zones` or `/zone list` → list claims.
  // `/zone claim <path>` → claim a file.
  // `/zone release <path>` → release a claim.
  const sub = (rest[0] || "list").toLowerCase();
  if (sub === "list" || sub === "help") {
    try {
      const r = await api.auraCli(repoRoot, ["zones", "list"]);
      const body = r.stdout?.trim() || "";
      const empty = body === "" || /no active|no zones|0 zones?/i.test(body);
      if (empty) {
        return { handled: true, tone: "info", output: ZONES_EMPTY_LEARN };
      }
      return {
        handled: true,
        tone: "info",
        output: `**Zone claims**\n\n${softWrap(truncate(body, 2000))}\n\n_Tip: \`/zone claim <path>\` to take ownership, \`/zone release <path>\` to let go._`,
      };
    } catch (e) {
      return {
        handled: true,
        tone: "warn",
        output: `/zones failed: ${errorMsg(e)}`,
      };
    }
  }
  if (sub === "claim" || sub === "release") {
    const path = rest.slice(1).join(" ").trim();
    if (!path) {
      return {
        handled: true,
        tone: "warn",
        output: `Usage: \`/zone ${sub} <path>\``,
      };
    }
    try {
      const r = await api.auraCli(repoRoot, ["zones", sub, path]);
      const body = r.stdout?.trim() || r.stderr?.trim() || `ok: ${sub} ${path}`;
      return {
        handled: true,
        tone: r.status === 0 ? "ok" : "warn",
        output: `**/zone ${sub} ${path}**\n\n${softWrap(truncate(body, 1500))}`,
      };
    } catch (e) {
      return {
        handled: true,
        tone: "warn",
        output: `/zone ${sub} failed: ${errorMsg(e)}`,
      };
    }
  }
  return {
    handled: true,
    tone: "warn",
    output: "Usage: `/zones`, `/zone claim <path>`, `/zone release <path>`.",
  };
}

async function runTeam(repoRoot: string, rest: string[]): Promise<ChatSlashResult> {
  // `/team` → onboarding + status. `/team members` → list members.
  // `/team invite <email>` → invite.
  const sub = (rest[0] || "status").toLowerCase();
  if (sub === "invite") {
    const target = rest.slice(1).join(" ").trim();
    if (!target) {
      return {
        handled: true,
        tone: "warn",
        output: "Usage: `/team invite <email>`",
      };
    }
    try {
      const r = await api.auraCli(repoRoot, ["team", "invite", target]);
      const body = r.stdout?.trim() || r.stderr?.trim() || `invited ${target}`;
      return {
        handled: true,
        tone: r.status === 0 ? "ok" : "warn",
        output: `**/team invite ${target}**\n\n${softWrap(truncate(body, 1500))}`,
      };
    } catch (e) {
      return {
        handled: true,
        tone: "warn",
        output: `/team invite failed: ${errorMsg(e)}`,
      };
    }
  }
  const verb = sub === "members" ? "list" : "status";
  try {
    const r = await api.auraCli(repoRoot, ["team", verb]);
    const body = r.stdout?.trim() || r.stderr?.trim() || "(no team info)";
    return {
      handled: true,
      tone: "info",
      output: softWrap(truncate(body, 2000)),
    };
  } catch (e) {
    return {
      handled: true,
      tone: "warn",
      output: `/team failed: ${errorMsg(e)}`,
    };
  }
}

async function runTaste(repoRoot: string, rest: string[]): Promise<ChatSlashResult> {
  // /taste                       → list active rules
  // /taste pending               → candidate + provisional rules awaiting promotion
  // /taste status                → observation + rule counts
  // /taste rule <id> | explain <id> → show one rule + backing observations
  // /taste approve <id>          → mark a rule user_approved
  // /taste reject <id>           → deprecate a rule (alias: /taste off <id>)
  // /taste sync                  → re-aggregate + refresh CLAUDE.md taste block
  const sub = (rest[0] || "list").toLowerCase();

  // Plain alias map → straight pass-through to the CLI.
  const aliases: Record<string, string[]> = {
    list: ["taste", "list", "--status", "active"],
    pending: ["taste", "list", "--status", "provisional"],
    candidates: ["taste", "list", "--status", "candidate"],
    deprecated: ["taste", "list", "--status", "deprecated"],
    all: ["taste", "list"],
    status: ["taste", "status"],
  };

  if (aliases[sub]) {
    return runCli(repoRoot, aliases[sub], `/taste ${sub === "list" ? "" : sub}`.trim());
  }

  if (sub === "rule" || sub === "explain") {
    const id = rest.slice(1).join(" ").trim();
    if (!id) {
      return {
        handled: true,
        tone: "warn",
        output: "Usage: `/taste rule <rule_id>` (get ids from `/taste` or `/taste pending`).",
      };
    }
    return runCli(repoRoot, ["taste", "explain", id], `/taste rule ${id}`);
  }

  if (sub === "approve" || sub === "reject" || sub === "off") {
    const id = rest.slice(1).join(" ").trim();
    if (!id) {
      return {
        handled: true,
        tone: "warn",
        output: `Usage: \`/taste ${sub} <rule_id>\``,
      };
    }
    return runCli(repoRoot, ["taste", sub, id], `/taste ${sub} ${id}`);
  }

  if (sub === "sync") {
    // Re-aggregate first, then regenerate CLAUDE.md. We chain them so
    // the bubble reflects the new active count.
    try {
      const mine = await api.auraCli(repoRoot, ["taste", "mine"]);
      const sync = await api.auraCli(repoRoot, ["taste", "sync-claude-md"]);
      const body =
        (mine.stdout?.trim() ? mine.stdout.trim() + "\n" : "") +
        (sync.stdout?.trim() || sync.stderr?.trim() || "");
      return {
        handled: true,
        tone: sync.status === 0 ? "ok" : "warn",
        output: `**/taste sync**\n\n${softWrap(truncate(body, 2000))}`,
      };
    } catch (e) {
      return {
        handled: true,
        tone: "warn",
        output: `/taste sync failed: ${errorMsg(e)}`,
      };
    }
  }

  return {
    handled: true,
    tone: "warn",
    output:
      "Usage: `/taste` (active rules), `/taste pending`, `/taste status`, `/taste rule <id>`, `/taste approve|reject <id>`, `/taste sync`.",
  };
}

async function runOrchestrate(repoRoot: string, rest: string[]): Promise<ChatSlashResult> {
  // /orchestrate                  → status
  // /orchestrate status           → status
  // /orchestrate pause|resume|cancel
  // /orchestrate run <objective> [--duo]
  // /orchestrate <objective>      → run with smart strategy (alias for `run`)
  const sub = (rest[0] || "status").toLowerCase();

  if (sub === "status" || sub === "pause" || sub === "cancel") {
    return runCli(repoRoot, ["orchestrate", sub], `/orchestrate ${sub}`);
  }
  if (sub === "resume") {
    const base = rest.slice(1).join(" ").trim() || "main";
    return runCli(repoRoot, ["orchestrate", "resume", "--base", base], `/orchestrate resume`);
  }
  if (sub === "run") {
    const objective = rest.slice(1).join(" ").trim();
    if (!objective) {
      return {
        handled: true,
        tone: "warn",
        output: "Usage: `/orchestrate run <objective>` or `/orchestrate <objective>`.",
      };
    }
    const duo = objective.includes("--duo");
    const cleaned = objective.replace(/--duo/g, "").trim();
    const args = duo
      ? ["orchestrate", "run", cleaned, "--duo"]
      : ["orchestrate", "run", cleaned];
    return runCli(repoRoot, args, `/orchestrate run ${cleaned}`);
  }

  // Fallback: treat the entire arg list as an objective for a smart run.
  const objective = rest.join(" ").trim();
  if (!objective) {
    return {
      handled: true,
      tone: "warn",
      output: "Usage: `/orchestrate` (status), `/orchestrate run <objective>`, `/orchestrate pause|resume|cancel`.",
    };
  }
  return runCli(repoRoot, ["orchestrate", "run", objective], `/orchestrate ${objective}`);
}

// ─── /loop — the unified ready_view over the shared aura-loop graph ──────

/** Render one loop node as a bullet line: priority, title, and a JIRA chip
 *  when the node was projected from an externally-imported board card. */
function loopLine(t: LoopTask): string {
  const pri = t.priority && t.priority !== "low" ? ` \`${t.priority}\`` : "";
  const jira =
    t.external_source === "jira" && t.external_id ? ` _(JIRA ${t.external_id})_` : "";
  return `- ${t.title}${pri}${jira}`;
}

async function runLoop(repoRoot: string, rest: string[]): Promise<ChatSlashResult> {
  // /loop | /loop status   → the unified ready_view
  // /loop sync             → project the board (incl. Jira) into the graph
  // /loop run [n]          → claim the ready set + dispatch into the native brain
  const sub = (rest[0] || "status").toLowerCase();

  if (sub === "sync") {
    try {
      const r = await api.loopSyncBoard(repoRoot);
      const lines = [
        `**/loop sync**. Board → dependency graph`,
        "",
        `- **${r.synced}** nodes in scope (${r.created} new, ${r.updated} updated)`,
        `- **${r.edges}** dependency edges reconciled`,
        "",
        "_Run `/loop` to see the ready set, `/loop run` to start it._",
      ];
      return { handled: true, tone: "ok", output: lines.join("\n") };
    } catch (e) {
      return { handled: true, tone: "warn", output: `/loop sync failed: ${errorMsg(e)}` };
    }
  }

  if (sub === "run") {
    const n = parseInt(rest[1] || "", 10);
    const max = Number.isFinite(n) && n > 0 ? n : undefined;
    try {
      const r = await api.loopRunNative(repoRoot, max);
      if (r.dispatched.length === 0) {
        return {
          handled: true,
          tone: "info",
          output:
            "**/loop run**. Nothing ready to dispatch. Try `/loop sync` first, or `/loop` to see what's blocked.",
        };
      }
      const lines = [
        `**/loop run**. Dispatched **${r.dispatched.length}** into the Aura brain`,
        "",
        ...r.dispatched.map((d) => `- ${d.title || d.node_id}`),
      ];
      if (r.ready_remaining > 0) {
        lines.push("", `_${r.ready_remaining} more ready. Re-run \`/loop run\` to continue._`);
      }
      return { handled: true, tone: "ok", output: lines.join("\n") };
    } catch (e) {
      return { handled: true, tone: "warn", output: `/loop run failed: ${errorMsg(e)}` };
    }
  }

  if (sub === "status" || sub === "list" || sub === "help") {
    try {
      const v = await fetchReadyView(repoRoot);
      const c = v.counts;
      if (c.ready + c.blocked + c.working + c.done + c.other === 0) {
        return {
          handled: true,
          tone: "info",
          output:
            "**Loop graph. Empty.** Run `/loop sync` to project the task board (including any Jira-imported cards) into the dependency graph, then `/loop run` to dispatch the ready set.",
        };
      }
      const lines: string[] = [
        `**Loop ready_view** · ${c.ready} ready · ${c.blocked} blocked · ${c.working} working · ${c.done} done`,
      ];
      if (v.ready.length) {
        lines.push("", "**Ready**", ...v.ready.slice(0, 12).map(loopLine));
      }
      if (v.working.length) {
        lines.push("", "**Working**", ...v.working.slice(0, 8).map(loopLine));
      }
      if (v.blocked.length) {
        lines.push(
          "",
          "**Blocked**",
          ...v.blocked
            .slice(0, 8)
            .map((b) => `${loopLine(b.task)}. Waiting on ${b.unmet.length}`),
        );
      }
      lines.push("", "_`/loop sync` to refresh from the board · `/loop run` to dispatch._");
      return { handled: true, tone: "info", output: lines.join("\n") };
    } catch (e) {
      return { handled: true, tone: "warn", output: `/loop failed: ${errorMsg(e)}` };
    }
  }

  return {
    handled: true,
    tone: "warn",
    output: "Usage: `/loop` (ready_view), `/loop sync` (board→graph), `/loop run [n]` (dispatch).",
  };
}

async function runCli(
  repoRoot: string,
  args: string[],
  label: string,
): Promise<ChatSlashResult> {
  try {
    const r = await api.auraCli(repoRoot, args);
    const body = r.stdout?.trim() || r.stderr?.trim() || "(no output)";
    return {
      handled: true,
      tone: r.status === 0 ? "info" : "warn",
      output: softWrap(truncate(body, 4000)),
    };
  } catch (e) {
    return {
      handled: true,
      tone: "warn",
      output: `${label} failed: ${errorMsg(e)}`,
    };
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(${s.length - max} more chars)`;
}

/** Render CLI / tool stdout as a plain chat message: keep its line breaks
 *  (markdown hard-breaks) but WITHOUT a monospace code-fence box, so the result
 *  reads like a normal reply instead of a boxed "component". */
function softWrap(body: string): string {
  return body
    .replace(/\r/g, "")
    .trimEnd()
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .join("  \n");
}

function errorMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
