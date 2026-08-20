// Where a freshly made copy of a project puts you.
//
// Making a parallel copy used to have exactly one ending: an Aura chat, opened
// for you, with your objective as its first message. That is a good default for
// someone describing work in prose — and the wrong one for someone who already
// lives in Claude Code or Codex and wanted the copy so they could point their
// own CLI at it. They arrived in a chat they didn't ask for and had to close it.
//
// So the ending is now a setting — `[workspace] open_in` in
// `~/.aura/settings.toml`, one string, three shapes:
//
//   "code"            land in the copy and open nothing. The default: a new
//                     copy is a place to work, and what opens in it is the
//                     user's next decision, not ours.
//   "chat"            an Aura chat seeded with the objective — the old
//                     behaviour, kept whole for the people it suited.
//   an agent CLI id   ("claude", "codex", "gemini", "cursor", "kimi",
//                     "opencode", "pi") — that CLI's terminal in the new copy,
//                     with the objective typed into it.
//
// **A loose string, deliberately.** An enum would make the setting file the
// authority on which agents exist, and it isn't — agents come and go with
// what's installed on the machine, and a settings file written by a newer
// build has to be readable by an older one. So an unrecognised value is not an
// error: `resolveWorkspaceLanding` degrades it to "code". Uninstall Codex and
// your copies quietly stop opening Codex instead of failing to open at all.
//
// **The objective survives every branch.** Losing it is the specific
// regression this file has to not cause — see the header of
// `workspaceChatLaunch.ts` for the original bug, and `agentPromptSeed.ts` for
// the paint-then-type dance the agent branch reuses rather than reinvents.

import { api } from "./api";
import type { AgentTab } from "./editorStore";
import type { ReasoningEffort } from "./api";
import { seedAgentPrompt } from "./agentPromptSeed";
import { getPermissionMode, streamChannel } from "./agentStreamStore";
import { letterMark } from "./monogram";
import type { SelectedModel } from "./modelCatalog";
import { getSettings } from "./settingsStore";
import { openWorktreeAuraChat } from "./workspaceChatLaunch";

/** Land in the copy and open nothing. */
export const LANDING_CODE = "code";
/** Land in an Aura chat, seeded with the objective. */
export const LANDING_CHAT = "chat";

export type WorkspaceLanding =
  | { kind: "code" }
  | { kind: "chat" }
  | { kind: "agent"; agentId: string };

/**
 * Read the stored `open_in` string as a landing.
 *
 * Pure, and the only place the string is interpreted. `installedAgentIds` is
 * what `api.agentsList()` reports as *available* — an id outside that set
 * resolves to `"code"` rather than spawning a CLI that isn't there, because
 * "the setting names an agent you uninstalled" and "the setting is from a
 * newer build" are the same failure from here, and both want the same
 * harmless answer.
 */
export function resolveWorkspaceLanding(
  raw: string | null | undefined,
  installedAgentIds: readonly string[],
): WorkspaceLanding {
  const value = (raw ?? "").trim();
  if (value === LANDING_CHAT) return { kind: "chat" };
  if (value && value !== LANDING_CODE && installedAgentIds.includes(value)) {
    return { kind: "agent", agentId: value };
  }
  return { kind: "code" };
}

/** Resolve the setting against what is actually installed right now. A failed
 *  agent enumeration is not a reason to refuse to open the copy — it just
 *  means we cannot honour an agent choice, so the landing falls back the same
 *  way an uninstalled agent does. */
export async function currentWorkspaceLanding(): Promise<WorkspaceLanding> {
  const raw = getSettings().workspace.open_in;
  if (raw === LANDING_CHAT || raw === LANDING_CODE || !raw) {
    return resolveWorkspaceLanding(raw, []);
  }
  let installed: string[] = [];
  try {
    installed = (await api.agentsList())
      .filter((a) => a.available)
      .map((a) => a.id);
  } catch (e) {
    console.warn("[workspace] could not list agents for the landing:", e);
  }
  return resolveWorkspaceLanding(raw, installed);
}

export type LandWorkspaceOptions = {
  /** The new copy's directory — already switched into by the caller. */
  worktreePath: string;
  /** What the user typed. Empty means there is nothing to seed, and every
   *  landing collapses to "code": opening an empty chat or a bare CLI the user
   *  didn't ask for is worse than opening nothing. */
  mission: string;
  /** Composer's model/effort, carried into the chat landing. Agent CLIs pick
   *  their own model from their own config — Aura holds no key for them. */
  model: SelectedModel | null;
  effort: ReasoningEffort | null;
  /** The editor store's `openAgent`, passed in rather than imported: it lives
   *  on the store instance the window holds, and this module has no business
   *  reaching for a React ref. */
  openAgent: (
    tab: Omit<AgentTab, "view" | "mode"> & {
      view?: "ui" | "terminal";
      mode?: "stream" | "pty" | "chat";
    },
  ) => void;
  /** Label for the agent tab, resolved by the caller from the agent catalog.
   *  Falls back to the id, which is what the catalog would give us anyway for
   *  an agent it doesn't recognise. */
  labelForAgent?: (agentId: string) => string;
};

/**
 * Open whatever the user's setting says a new copy opens into.
 *
 * Called only after the app has switched INTO the copy — same rule the chat
 * landing has always had. Starting a session from the outgoing workspace files
 * it under that workspace's snapshot, and the tab opens onto a blank screen.
 */
export async function landNewWorkspace(
  opts: LandWorkspaceOptions,
): Promise<void> {
  const mission = opts.mission.trim();
  if (!mission) return;

  const landing = await currentWorkspaceLanding();
  if (landing.kind === "code") return;

  if (landing.kind === "chat") {
    await openWorktreeAuraChat(
      opts.worktreePath,
      mission,
      opts.model,
      opts.effort,
    );
    return;
  }

  await openWorktreeAgent(landing.agentId, mission, opts);
}

/** Spawn one agent CLI in the copy, put its tab in front of the user, and type
 *  the objective in once the TUI has painted. */
async function openWorktreeAgent(
  agentId: string,
  mission: string,
  opts: LandWorkspaceOptions,
): Promise<void> {
  const label = opts.labelForAgent?.(agentId) ?? agentId;
  // A worktree is a directory on THIS laptop — `workspace_launch` only makes
  // them here — so the agent that edits it runs here too. Same reasoning as
  // `WORKTREE_RUNS_HERE` in `workspaceChatLaunch.ts`: reading the focused
  // place would be wrong, because the launch just moved it.
  const RUNS_HERE = null;
  const permission = getPermissionMode(streamChannel(agentId, opts.worktreePath));
  try {
    const handle = await api.agentPtyOpen(
      agentId,
      opts.worktreePath,
      80,
      24,
      undefined,
      true,
      undefined,
      permission === "default" ? undefined : permission,
      RUNS_HERE,
    );
    opts.openAgent({
      sessionId: handle.id,
      agentId,
      agentLabel: label,
      agentMonogram: letterMark(label),
      repoRoot: opts.worktreePath,
      mode: "pty",
      machineId: RUNS_HERE,
    });
    seedAgentPrompt(handle.id, mission);
  } catch (e) {
    // The copy itself is fine and the user is standing in it — falling back to
    // a chat would be a second surprise on top of the first. Say what failed
    // and leave them in the code.
    console.error(
      `[workspace] could not start ${agentId} in the new copy:`,
      e,
    );
  }
}
