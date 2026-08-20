// Landing a freshly launched workspace in Aura chat.
//
// Starting a workspace used to spawn a Claude Code terminal in the new
// worktree and type the objective into it once the TUI had painted. The
// objective went missing whenever that injection lost the race with the CLI's
// own startup — the user watched the setup steps run, arrived in Claude, and
// their message wasn't there. It also routed people straight past Aura into a
// bare agent terminal.
//
// So a launch now provisions the worktree and calls this: one Aura chat in the
// new copy, the objective as its first message, the composer's model on the
// chip and driving the turn.
//
// Order matters and is the whole reason this isn't three inline lines:
//
//   1. start the session      — we need its id before anything can be keyed to it
//   2. write model + brain    — ManagerChatView seeds its chips from storage in an
//                               effect keyed on the session id and never re-reads,
//                               so anything written after the view mounts is invisible
//                               until a reload
//   3. focus it               — opens the chat tab
//   4. send the objective     — through the same path a typed message takes
//
// Called only after the app has switched INTO the worktree. Starting the
// session from the outgoing workspace would file it under that workspace's
// snapshot — the same trap that used to make launched agent tabs open onto a
// blank screen.

import { api } from "./api";
import type { ReasoningEffort } from "./api";
import { focusAmbientManager } from "./focusManager";
import { saveSessionBrain, saveSessionModel } from "./managerSessionPrefs";
import { sendAmbientManagerTurn } from "./managerTurn";
import type { SelectedModel } from "./modelCatalog";

// The place this chat runs in. A worktree is a directory on a particular
// computer and `workspace_launch` only makes them on this laptop — see the
// refusal in `workspaceCreateStore.launchWorkspace` — so `worktreePath` is a
// path here, and the chat that edits it has to have its hands here too.
//
// It is named rather than left off deliberately: every other entry point now
// reads the focused place, and reading it here would be wrong. The launch
// switches workspaces and this chat opens after the switch, so "wherever the
// window is standing" is a moving target that has nothing to do with which
// disk the new copy landed on.
const WORKTREE_RUNS_HERE = null;

/**
 * Open the worktree's Aura chat with `mission` as its first message.
 * Returns the session id, or null if the chat could not be started.
 */
export async function openWorktreeAuraChat(
  worktreePath: string,
  mission: string,
  model: SelectedModel | null,
  effort: ReasoningEffort | null,
): Promise<string | null> {
  const text = mission.trim();
  if (!text) return null;

  let sid: string;
  try {
    // Seeds the session with the objective; step 4 delivers it as the first
    // user turn — the same two-step every other chat entry point uses.
    sid = await api.managerChatStart(worktreePath, text, WORKTREE_RUNS_HERE);
  } catch (e) {
    console.error("[workspace] could not start Aura chat in the new worktree:", e);
    return null;
  }

  if (model) {
    saveSessionModel(sid, model);
    // The chip and the engine have to agree: persisting a model without the
    // brain it belongs to leaves the chat showing one thing and running the
    // globally-active brain. Resolving the brain can fail (offline catalog) —
    // the turn below still carries `brainId` explicitly, so the dispatch is
    // correct either way; only the header's brain label would be missing.
    try {
      const brains = await api.managerListBrains();
      const brain = brains.find((b) => b.id === model.brainId);
      if (brain) saveSessionBrain(sid, brain);
    } catch {
      /* catalog unavailable — chip + per-turn routing are already set */
    }
  }

  focusAmbientManager(worktreePath, sid, WORKTREE_RUNS_HERE);

  await sendAmbientManagerTurn(worktreePath, text, {
    sessionId: sid,
    machineId: WORKTREE_RUNS_HERE,
    model: model?.modelId ?? null,
    longContext: model?.longContext ?? false,
    brainId: model?.brainId ?? null,
    effort,
  });
  return sid;
}
