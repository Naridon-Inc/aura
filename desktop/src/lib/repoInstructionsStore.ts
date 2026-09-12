// The live side of per-repo instructions: a small cache of the three texts
// per repo root, filled from `repo_worktree_settings_get` and refreshed when
// the settings pane saves.
//
// Why a cache with a sync read: the prompt builders in `worktreeActions.ts`
// (`createPrPrompt`, `resolveConflictsPrompt`) are synchronous and called
// from half a dozen buttons that don't know the repo root. Asking every one
// of them to go async just to append two lines would spread the change
// across files this cluster doesn't own. So the builders read the ACTIVE
// repo's instructions synchronously from here, and this module keeps that
// entry warm: primed on load, re-primed when the active workspace is asked
// for again, and reloaded on `aura:worktree-settings-saved`.

import { repoWorktreeSettingsGet } from "./api";
import { getActiveWorkspaceRoot } from "./editorStore";
import {
  EMPTY_INSTRUCTIONS,
  instructionsFromSettings,
  type RepoInstructions,
} from "./repoInstructions";

type Entry = { value: RepoInstructions; fetchedAt: number };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<RepoInstructions>>();

/** After this the entry is served but refreshed in the background. */
const STALE_MS = 60_000;

/** Fetch the instructions for one repo, de-duplicating concurrent calls.
 *  A failed read (no settings file, backend older than this feature) is
 *  cached as empty so a broken repo never makes the prompt buttons retry
 *  on every click. */
export async function loadRepoInstructions(
  repoRoot: string,
): Promise<RepoInstructions> {
  const pending = inflight.get(repoRoot);
  if (pending) return pending;
  const task = (async () => {
    let value = EMPTY_INSTRUCTIONS;
    try {
      value = instructionsFromSettings(await repoWorktreeSettingsGet(repoRoot));
    } catch {
      // Empty is the honest answer: nothing configured that we can read.
    }
    cache.set(repoRoot, { value, fetchedAt: Date.now() });
    return value;
  })();
  inflight.set(repoRoot, task);
  try {
    return await task;
  } finally {
    inflight.delete(repoRoot);
  }
}

/** The cached instructions for a repo, or empty when nothing is known yet.
 *  Kicks off a background load when the entry is missing or stale, so the
 *  next call has the real answer. */
export function getRepoInstructionsCached(
  repoRoot: string | null | undefined,
): RepoInstructions {
  if (!repoRoot) return EMPTY_INSTRUCTIONS;
  const entry = cache.get(repoRoot);
  if (!entry || Date.now() - entry.fetchedAt > STALE_MS) {
    void loadRepoInstructions(repoRoot);
  }
  return entry?.value ?? EMPTY_INSTRUCTIONS;
}

/** Instructions for whichever workspace the shell is bound to right now. */
export function activeRepoInstructions(): RepoInstructions {
  return getRepoInstructionsCached(getActiveWorkspaceRoot());
}

/** Forget a repo's entry (or all of them) so the next read refetches. */
export function invalidateRepoInstructions(repoRoot?: string): void {
  if (repoRoot) cache.delete(repoRoot);
  else cache.clear();
}

// Settings saved → the active repo's texts may have changed. The pane fires
// this without a repo root, so drop everything and warm the active one.
if (typeof window !== "undefined") {
  window.addEventListener("aura:worktree-settings-saved", () => {
    invalidateRepoInstructions();
    const root = getActiveWorkspaceRoot();
    if (root) void loadRepoInstructions(root);
  });
  // Warm the active repo once at startup so the first "Create PR" click
  // already has the repo's rules rather than the empty fallback.
  const root = getActiveWorkspaceRoot();
  if (root) void loadRepoInstructions(root);
}
