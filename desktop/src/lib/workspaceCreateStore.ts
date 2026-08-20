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
//
// ## Two places, one call
//
// `machineId` names where the work is made. It used to be refused outright —
// "Workspaces are made on this laptop" — which meant the only route to a cloud
// workspace was to walk into the machine and create one from over there. The
// place was chosen by navigating rather than by picking, so it was never really
// a choice at all.
//
// Nothing had to be built for the other half: a box makes a worktree with
// `cloudbox::script::add_worktree` and holds the agent in tmux, which is how
// every session on a machine has always worked. This is the routing, and it is
// deliberately the SAME function rather than a second `launchRemoteWorkspace`
// beside it — the moment there are two, one of them starts getting the fixes.

import { seedAgentPrompt } from "./agentPromptSeed";
import {
  api,
  type BoxSession,
  type LaunchAgentSpec,
  type ReasoningEffort,
  type WorkspaceLaunchManifest,
} from "./api";
import { appendAgentTabPassive } from "./editorStore";
import { whyNotOffered } from "./place";
import {
  beginInFlight,
  markInFlightError,
  markInFlightReady,
  markInFlightSpawning,
} from "./workspaceInFlightStore";
import { buildWorkspacePromptContext } from "./workspacePromptContext";
import { labelForAgentId } from "./useLiveAgentSessions";

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
  /** Don't place the agent tabs here. The caller is about to switch INTO the
   *  new worktree itself (single launch) and will open them actively post-
   *  switch — see the note in the body. Default (undefined/false): tabs land
   *  passively so a background launch surfaces on switch-over. */
  deferTabPlacement?: boolean;
  /** Where the work is made. `null`/omitted is this laptop — the same spelling
   *  `Place.machineId` uses, so the local arm is expressible in the same words
   *  as the remote one instead of being a different function. */
  machineId?: string | null;
  /** Where this project sits ON that machine, when the caller already knows
   *  (the machine book usually does). Omitted → the box is asked which projects
   *  it holds, because a plausible path invented here is a directory the box
   *  has never seen. Ignored for a local launch. */
  remoteProjectPath?: string | null;
};

/** One launched agent, shaped for `openAgent`/`appendAgentTabPassive`. */
export type LaunchedAgentTab = {
  sessionId: string;
  agentId: string;
  agentLabel: string;
  agentMonogram: string;
  repoRoot: string;
};

export type LaunchWorkspaceResult = {
  /** The local launch manifest — `null` when the work was made on a box, which
   *  has no local worktree and no local PTYs to describe. */
  manifest: WorkspaceLaunchManifest | null;
  /** Where the work landed: a directory on this disk, or one on the box. Read
   *  back off whichever place made it rather than composed here. */
  worktreePath: string;
  /** The machine it was made on, or `null` for this laptop. */
  machineId: string | null;
  /** The sessions the box started, in the order asked. Empty for a local
   *  launch, whose sessions live on `manifest`. */
  remoteSessions: BoxSession[];
  /** Whatever failed per agent. The worktree itself failing throws instead —
   *  there is nothing to come back to. */
  errors: string[];
  /** The prompt actually seeded (with context block), if any. */
  seededPrompt: string | null;
  /** The agent tabs this launch created. Placed passively here unless
   *  `deferTabPlacement` was set — then the caller opens them actively after
   *  switching into the worktree, so a single launch lands the user in the
   *  running chat instead of the empty worktree state. Always empty for a
   *  remote launch: those agents run in tmux on the box, and they are opened by
   *  entering the machine's workspace, not by a tab in this one. */
  tabs: LaunchedAgentTab[];
};

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
    req.startPoint ?? "HEAD",
  );

  // A place was named. The worktree is made over there and the agents run
  // over there; nothing about that arrives in this window as a tab.
  const machineId = req.machineId?.trim();
  if (machineId) return launchOnMachine(req, machineId, key);

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

  // Author every launched agent's tab spec once (used for placement here or by
  // the caller post-switch).
  const tabs: LaunchedAgentTab[] = manifest.sessions.map((session) => {
    const label = labelForAgentId(session.agent_id);
    return {
      sessionId: session.id,
      agentId: session.agent_id,
      agentLabel: label,
      agentMonogram: label.charAt(0),
      repoRoot: session.repo_root,
    };
  });

  // Place tabs. Passive append — a background launch must never yank the user
  // out of the workspace they're standing in; tabs surface when they switch
  // over. A single launch instead sets `deferTabPlacement`: the caller switches
  // INTO the worktree and opens these actively there. Placing them passively
  // here in that case would misfile them — `switchWorkspace` serializes live
  // state into the OUTGOING workspace's snapshot before hydrating the target,
  // so the fresh tab would land under the old project and the worktree would
  // open empty (the "I started an agent but got a blank screen" bug).
  if (!req.deferTabPlacement) {
    for (const tab of tabs) appendAgentTabPassive(tab);
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
      seedAgentPrompt(session.id, seededPrompt);
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

  return {
    manifest,
    worktreePath: manifest.worktree.path,
    machineId: null,
    remoteSessions: [],
    errors: manifest.errors,
    seededPrompt,
    tabs,
  };
}

/** The same launch, made on a box.
 *
 *  `box_start` is the whole of it: given a branch it adds a worktree beside the
 *  project (`script::add_worktree`) and starts the agent in tmux inside it, so
 *  the work outlives the connection that asked for it — which is the reason for
 *  putting it there. Nothing is checked out on this laptop and no PTY runs here.
 *
 *  Each agent is started independently and its failure is ITS failure: on a box
 *  where two of three CLIs are installed, one missing binary must not take the
 *  other two down with it. The worktree is the exception — the first start
 *  makes it, and if that cannot happen there is nothing to come back to, so it
 *  throws. */
async function launchOnMachine(
  req: LaunchWorkspaceRequest,
  machineId: string,
  key: string,
): Promise<LaunchWorkspaceResult> {
  const mission = req.prompt?.trim() || null;
  let project: string;
  try {
    project = await remoteProjectPath(machineId, req.repoRoot, req.remoteProjectPath);
  } catch (e) {
    markInFlightError(key, e instanceof Error ? e.message : String(e));
    throw e;
  }

  const sessions: BoxSession[] = [];
  const errors: string[] = [];
  // No agents named is a real request — "give me the copy, I'll decide who
  // works in it" — and it still needs the worktree. A shell session is what
  // makes one and leaves you somewhere you can stand.
  const specs: LaunchAgentSpec[] = req.agents.length > 0 ? req.agents : [];
  const starts: { agent: string | null; label: string }[] =
    specs.length > 0
      ? specs.map((a) => ({ agent: a.agentId, label: labelForAgentId(a.agentId) }))
      : [{ agent: null, label: "Shell" }];

  for (const start of starts) {
    try {
      const session = await api.boxStart(machineId, {
        project,
        kind: start.agent ? "agent" : "shell",
        agent: start.agent,
        branch: req.branch,
        // What it is for is also what to call it — the only moment anybody
        // knows the answer.
        title: mission,
        prompt: start.agent ? mission : null,
      });
      sessions.push(session);
      // The box named the directory it actually made; the tile follows it
      // rather than a path composed on this side.
      if (sessions.length === 1) markInFlightSpawning(key, session.project);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // The first start is the one that makes the worktree. Its failure is the
      // launch failing — there is no copy to come back to, and trying the rest
      // would be two more round trips to be told the same thing.
      if (sessions.length === 0) {
        markInFlightError(key, message);
        throw e instanceof Error ? e : new Error(message);
      }
      errors.push(`${start.label}: ${message}`);
    }
  }

  const worktreePath = sessions[0]?.project ?? project;
  if (errors.length > 0) markInFlightError(key, errors.join("; "));
  else markInFlightReady(key, worktreePath);

  return {
    manifest: null,
    worktreePath,
    machineId,
    remoteSessions: sessions,
    errors,
    // The prompt went out with the session rather than being typed into a TUI
    // afterwards: `box_start` hands it to the CLI as its own argument, so
    // there is no first-paint race to lose it to.
    seededPrompt: mission,
    tabs: [],
  };
}

/** Where this project sits ON that machine.
 *
 *  Three answers, in order of how much we know. The caller's, when it has one.
 *  The machine book's, which recorded the directory when the box was connected.
 *  Failing both, the box's own list of projects, matched on the folder name —
 *  and when that finds nothing, a sentence saying so, because "your box doesn't
 *  have a copy of this yet" is actionable and a git error about a path that
 *  isn't there is not.
 *
 *  Exported because every surface that can send work to a box has to answer the
 *  same question, and two answers to "where does this project live over there"
 *  is how one door starts work in a directory the other one can't find. */
export async function remoteProjectPath(
  machineId: string,
  repoRoot: string,
  given?: string | null,
): Promise<string> {
  const asked = given?.trim();
  if (asked) return asked;

  const machine = await api
    .machinesList()
    .then((list) => list.find((m) => m.id === machineId) ?? null)
    .catch(() => null);
  const recorded = machine?.repo_path?.trim();
  if (recorded) return recorded;

  const wanted = baseName(repoRoot);
  const offered = await api.boxProjects(machineId);
  const hit =
    offered.projects.find((p) => p.name === wanted) ??
    offered.projects.find((p) => baseName(p.path) === wanted);
  if (hit) return hit.path;

  // It may be on the machine and simply not this org's. "Doesn't have a copy"
  // would send somebody to clone a repo that is already sitting there, and the
  // clone would land beside it under the same org that isn't theirs — so the
  // narrowing's own reason is repeated verbatim instead.
  const why = whyNotOffered(offered, wanted);
  if (why) {
    throw new Error(
      `${machine?.name ?? "That machine"} has ${wanted} on it, but not for the org ` +
        `you're in. ${why} Switch orgs to work on it there.`,
    );
  }

  throw new Error(
    `${machine?.name ?? "That machine"} doesn't have a copy of ${wanted} yet. ` +
      `Put one there from the machine's page, then start this work again.`,
  );
}

/** The last path component — what a project is called. */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}
