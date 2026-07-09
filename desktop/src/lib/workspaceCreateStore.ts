// Parity W8 — the launch driver: one call provisions a worktree workspace,
// spawns its agent fleet, lands the agent tabs in the editor model, and seeds
// each agent with an opening prompt.
//
// `launchWorkspace` orchestrates the whole arc around the `workspace_launch`
// Tauri command:
//
//   beginInFlight ("creating…")            — optimistic rail tile, instantly
//   api.workspaceLaunch                    — worktree + N PTY spawns, 1 round-trip
//   markInFlightSpawning → appendLaunches  — tabs land (passively if the user
//                                            is in another workspace)
//   seed prompts                           — after each agent's first output
//   markInFlightReady | markInFlightError  — tile resolves
//
// Prompt seeding waits for the agent CLI to actually paint (first
// `agent-pty:<id>` event + a settle beat) before injecting — typing into a
// TUI that hasn't drawn its input box yet drops the text. A hard timeout
// writes anyway so a quiet agent still gets its mission.

import { listen } from "@tauri-apps/api/event";

import {
  api,
  type LaunchAgentSpec,
  type ReasoningEffort,
  type WorkspaceLaunchManifest,
} from "./api";
import { appendAgentTabPassive } from "./editorStore";
import {
  beginInFlight,
  markInFlightError,
  markInFlightReady,
  markInFlightSpawning,
} from "./workspaceInFlightStore";
import { buildWorkspacePromptContext } from "./workspacePromptContext";

export type LaunchWorkspaceRequest = {
  /** Repo the worktree is created FROM. */
  repoRoot: string;
  /** Branch name for the new worktree. */
  branch: string;
  /** Start point — branch/sha/"HEAD". Defaults to HEAD. */
  startPoint?: string;
  /** Agents to spawn inside the worktree, in order. */
  agents: LaunchAgentSpec[];
  /** Opening mission injected into every agent once it has painted. */
  prompt?: string;
  /** Append the task-board context block to the seed prompt. */
  includeTaskContext?: boolean;
  /** Explicit tasks (id or `AURA-<n>`) for the context block. */
  taskIds?: string[];
  /** Model id (e.g. `"claude-opus-4-8"`) applied to every spawned agent's
   *  CLI (`claude --model`, `gemini -m`, …). Omit → the agent keeps its own
   *  configured default. Per-agent specs that already name a model win. */
  model?: string;
  /** Cross-agent reasoning effort applied to every spawned agent. Omit → the
   *  agent's own default. Per-agent specs that already set effort win. */
  effort?: ReasoningEffort;
};

export type LaunchWorkspaceResult = {
  manifest: WorkspaceLaunchManifest;
  /** The prompt actually seeded (with context block), if any. */
  seededPrompt: string | null;
};

/** How long to wait after the agent's first output before injecting — the
 *  TUI is usually mid-paint on its very first bytes. */
const SEED_SETTLE_MS = 600;
/** Give up waiting for first output and inject anyway. */
const SEED_TIMEOUT_MS = 5000;

/** Humanize an agent id for the tab label: `cursor-agent` → `Cursor Agent`. */
function labelForAgent(agentId: string): string {
  return agentId
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Wait for the session's first PTY output, then a settle beat; resolve after
 *  SEED_TIMEOUT_MS regardless so seeding never hangs on a silent agent. */
async function waitForFirstPaint(sessionId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    let unlisten: (() => void) | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      unlisten?.();
      resolve();
    };
    const timeout = setTimeout(finish, SEED_TIMEOUT_MS);
    listen(`agent-pty:${sessionId}`, () => {
      setTimeout(finish, SEED_SETTLE_MS);
    })
      .then((un) => {
        unlisten = un;
        // Listener attached after the event already fired (fast agent) is
        // covered by the hard timeout — replay isn't needed for seeding.
        if (done) un();
      })
      .catch(() => finish());
  });
}

/**
 * Launch a workspace: worktree + agent fleet + tabs + seed prompts, driving
 * the in-flight rail tile through its lifecycle. Resolves once the manifest
 * is back and tabs are placed — prompt seeding continues in the background.
 * Throws (after marking the tile errored) only when the worktree itself
 * failed; per-agent spawn failures ride home in `manifest.errors`.
 */
export async function launchWorkspace(req: LaunchWorkspaceRequest): Promise<LaunchWorkspaceResult> {
  const key = beginInFlight(
    req.repoRoot,
    req.branch,
    req.agents.map((a) => a.agentId),
  );

  // Fold the launch-level model/effort onto each agent spec so a single
  // composer choice applies to the whole fleet — a spec that already names
  // its own model/effort keeps it.
  const agents: LaunchAgentSpec[] = req.agents.map((a) => ({
    ...a,
    model: a.model ?? req.model ?? null,
    effort: a.effort ?? req.effort ?? null,
  }));

  let manifest: WorkspaceLaunchManifest;
  try {
    manifest = await api.workspaceLaunch(req.repoRoot, req.branch, req.startPoint ?? "HEAD", agents);
  } catch (e) {
    markInFlightError(key, e instanceof Error ? e.message : String(e));
    throw e;
  }

  markInFlightSpawning(key, manifest.worktree.path);

  // Place tabs. Passive append — a launch must never yank the user out of
  // the workspace they're standing in; tabs surface when they switch over.
  for (const session of manifest.sessions) {
    appendAgentTabPassive({
      sessionId: session.id,
      agentId: session.agent_id,
      agentLabel: labelForAgent(session.agent_id),
      agentMonogram: labelForAgent(session.agent_id).charAt(0),
      repoRoot: session.repo_root,
    });
  }

  // Build the seed prompt once (context block included), then inject into
  // each agent as it paints. Fire-and-forget: the launch result doesn't wait
  // on slow TUI boots.
  let seededPrompt: string | null = null;
  const mission = req.prompt?.trim();
  if (mission && manifest.sessions.length > 0) {
    const context = req.includeTaskContext
      ? await buildWorkspacePromptContext(manifest.worktree.path, { taskIds: req.taskIds })
      : "";
    seededPrompt = context ? `${mission}\n\n${context}` : mission;
    for (const session of manifest.sessions) {
      const text = seededPrompt;
      void waitForFirstPaint(session.id).then(() =>
        api.agentPtySendPrompt(session.id, text).catch(() => {
          // Session died between spawn and seed — the tab's own surface
          // shows the exit; nothing useful to do here.
        }),
      );
    }
  }

  if (manifest.errors.length > 0) {
    // Total or partial spawn failure — surface the per-agent error text on a
    // sticky tile. On a partial fleet the worktree path is still set from
    // markInFlightSpawning, so the tile stays clickable into the workspace.
    markInFlightError(key, manifest.errors.join("; "));
  } else {
    markInFlightReady(key, manifest.worktree.path);
  }

  return { manifest, seededPrompt };
}
