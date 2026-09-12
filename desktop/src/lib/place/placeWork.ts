// The `place_*` commands, as the frontend calls them — every file, change
// and git question a workspace on a machine can ask, plus the two the
// History rail and the work tabs need.
//
// These are the invoke wrappers `workApi` routes to when a project is
// standing in a machine. They sit here rather than in lib/api so the one
// argument every twin now carries — `remoteRoot`, the worktree ON THE BOX
// that a launched workspace lives in (`<project>-<branch>`, beside the
// machine's main checkout) — is spelled once, by the module that knows what
// it means, and reaches every command the same way. `machineId` and `root`
// (the LOCAL root, the key everything else uses) come first, as they always
// have; `remoteRoot` is optional and absent means the machine's own checkout.

import { invoke } from "@tauri-apps/api/core";

import type {
  AheadBehind,
  DirEntry,
  FileContent,
  FileDiffStat,
  GitBranchInfo,
  GitBranchRich,
  GitStatusEntry,
  GraphCommit,
} from "../api";

/** Where a routed command runs: which box, which local project, and — for a
 *  launched workspace — which worktree on the box. */
export type WorkAt = {
  machineId: string;
  repoRoot: string;
  remoteRoot?: string | null;
};

/** The three arguments every `place_*` command opens with. Spelled by one
 *  function so no twin can forget the worktree. */
function at(where: WorkAt) {
  return {
    machineId: where.machineId,
    root: where.repoRoot,
    remoteRoot: where.remoteRoot ?? null,
  };
}

// ─── Files ───────────────────────────────────────────────────────────────

export const placeFsList = (w: WorkAt, path: string) =>
  invoke<DirEntry[]>("place_fs_list", { ...at(w), path });
export const placeFsRead = (w: WorkAt, path: string) =>
  invoke<FileContent>("place_fs_read", { ...at(w), path });
export const placeFsWrite = (w: WorkAt, path: string, contents: string) =>
  invoke<void>("place_fs_write", { ...at(w), path, contents });
export const placeFsCreateFile = (w: WorkAt, path: string) =>
  invoke<string>("place_fs_create_file", { ...at(w), path });
export const placeFsCreateFolder = (w: WorkAt, path: string) =>
  invoke<string>("place_fs_create_folder", { ...at(w), path });
export const placeFsRename = (w: WorkAt, from: string, to: string) =>
  invoke<string>("place_fs_rename", { ...at(w), from, to });
export const placeFsDelete = (w: WorkAt, path: string) =>
  invoke<void>("place_fs_delete", { ...at(w), path });
export const placeFsFindFiles = (w: WorkAt) =>
  invoke<string[]>("place_fs_find_files", at(w));

// ─── Reading git ─────────────────────────────────────────────────────────

export const placeGitStatusV2 = (w: WorkAt) =>
  invoke<GitStatusEntry[]>("place_git_status_v2", at(w));
export const placeGitDiff = (w: WorkAt, file: string, sinceBase?: boolean) =>
  invoke<string>("place_git_diff", { ...at(w), file, sinceBase: sinceBase ?? null });
export const placeGitDiffAtCommit = (w: WorkAt, sha: string, file: string) =>
  invoke<string>("place_git_diff_at_commit", { ...at(w), sha, file });
export const placeGitDiffBase = (w: WorkAt, base: string, file: string) =>
  invoke<string>("place_git_diff_base", { ...at(w), base, file });
export const placeGitDiffStatsPerFile = (w: WorkAt, sinceBase?: boolean) =>
  invoke<FileDiffStat[]>("place_git_diff_stats_per_file", {
    ...at(w),
    sinceBase: sinceBase ?? null,
  });
export const placeGitBranch = (w: WorkAt) =>
  invoke<string>("place_git_branch", at(w));
export const placeGitBranches = (w: WorkAt) =>
  invoke<GitBranchInfo[]>("place_git_branches", at(w));
export const placeGitBranchesRich = (w: WorkAt) =>
  invoke<GitBranchRich[]>("place_git_branches_rich", at(w));
export const placeGitAheadBehind = (w: WorkAt) =>
  invoke<AheadBehind>("place_git_ahead_behind", at(w));
export const placeGitShowCommit = (w: WorkAt, sha: string) =>
  invoke<string>("place_git_show_commit", { ...at(w), sha });
export const placeGitShowHead = (w: WorkAt, file: string) =>
  invoke<string>("place_git_show_head", { ...at(w), file });
export const placeGitRemoteOrigin = (w: WorkAt) =>
  invoke<string>("place_git_remote_origin", at(w));
export const placeGitCommitGraph = (w: WorkAt, limit: number) =>
  invoke<GraphCommit[]>("place_git_commit_graph", { ...at(w), limit });

// ─── Moving git ──────────────────────────────────────────────────────────

export const placeGitStage = (w: WorkAt, paths: string[]) =>
  invoke<string>("place_git_stage", { ...at(w), paths });
export const placeGitUnstage = (w: WorkAt, paths: string[]) =>
  invoke<string>("place_git_unstage", { ...at(w), paths });
export const placeGitDiscard = (w: WorkAt, paths: string[]) =>
  invoke<string>("place_git_discard", { ...at(w), paths });
export const placeGitCommit = (w: WorkAt, message: string) =>
  invoke<string>("place_git_commit", { ...at(w), message });
export const placeGitPush = (w: WorkAt, setUpstream: boolean) =>
  invoke<string>("place_git_push", { ...at(w), setUpstream });
export const placeGitPull = (w: WorkAt) =>
  invoke<string>("place_git_pull", at(w));
export const placeGitFetch = (w: WorkAt) =>
  invoke<string>("place_git_fetch", at(w));
export const placeGitCheckout = (w: WorkAt, branch: string) =>
  invoke<string>("place_git_checkout", { ...at(w), branch });
export const placeGitCreateBranch = (w: WorkAt, name: string) =>
  invoke<string>("place_git_create_branch", { ...at(w), name });
export const placeGitResetFiles = (w: WorkAt) =>
  invoke<number>("place_git_reset_files", at(w));

// ─── Is there anything to open? ──────────────────────────────────────────

/** Resolves when the folder on the machine is a checkout the work tabs can
 *  open; rejects with the box's own sentence (what `cd` or `git` said over
 *  there) when it is not. */
export const placeWorkReady = (w: WorkAt) =>
  invoke<void>("place_work_ready", at(w));
