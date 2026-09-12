// The one door files, changes and git go through, wherever the checkout is.
//
// Every surface that reads a file, lists a folder, stages a hunk or pushes a
// branch used to call the local command straight off `api`. That was right for
// as long as the checkout was on this laptop. A workspace can now stand in a
// machine — its files are over there, its git is over there — and a local
// `git status` run against the laptop's copy of the project answers about the
// wrong computer while looking exactly like the right one.
//
// So: the same functions, the same signatures, and one question asked first.
// A project root (or a path under one) that `activeMachine` says belongs to
// the focused machine goes to the `place_*` twin, over the transport the
// window already holds; everything else goes where it always went. No surface
// has to know which, and none can get it wrong by forgetting to ask.
//
// Two rules keep this thin. Every function here is the twin of an `api.*`
// entry with the same name and parameters, so a caller swaps the import and
// nothing else. And the machine side never runs anything the local side
// doesn't: a place answers in the same shape, or it is not offered here.
//
// The machine side is `./placeWork`, and what it is handed is not a machine
// id but a `RemoteWorkAt`: the box, the local root, and — for a workspace
// launched onto the box — the worktree over there the work actually lives
// in. A launched workspace is a sibling checkout (`<project>-<branch>`), and
// a `git status` run in the machine's main checkout would answer about the
// wrong branch while looking exactly like the right one.

import { api } from "../api";
import type {
  AheadBehind,
  DiffStats,
  DirEntry,
  FileContent,
  FileDiffStat,
  GitBranchInfo,
  GitBranchRich,
  GitStatusEntry,
  GraphCommit,
  RunSuggestion,
} from "../api";
import {
  machineIdForRoot,
  remotePlaceForPath,
  remotePlaceForRoot,
} from "../activeMachine";
import * as place from "./placeWork";

/** A cache key that tells a project on this laptop apart from the same
 *  project as held by a machine. The two answer differently to every question
 *  below, and a cache keyed on the root alone would hand a box's listing to
 *  the laptop, or the other way round, the moment the window switched places.
 *  NUL cannot appear in a path, so the join is unambiguous. */
export function placeScope(repoRoot: string): string {
  const m = remotePlaceForRoot(repoRoot);
  if (!m) return repoRoot;
  // Two launched worktrees of one project on one box are two scopes: the
  // same local root, a different checkout over there.
  return m.remoteRoot
    ? `${m.machineId}\0${m.remoteRoot}\0${repoRoot}`
    : `${m.machineId}\0${repoRoot}`;
}

/** `placeScope`, for a bare path rather than a project root. */
export function pathScope(path: string): string {
  const at = remotePlaceForPath(path);
  return at ? `${at.machineId}\0${path}` : path;
}

/** The root (or path) a scope was made from — for a cache whose loader is
 *  handed the key and has to ask the question again. */
export function rootOfScope(scope: string): string {
  const cut = scope.lastIndexOf("\0");
  return cut < 0 ? scope : scope.slice(cut + 1);
}

// ─── Files ───────────────────────────────────────────────────────────────

export function listDir(path: string): Promise<DirEntry[]> {
  const at = remotePlaceForPath(path);
  return at ? place.placeFsList(at, path) : api.listDir(path);
}

export function readFile(path: string): Promise<FileContent> {
  const at = remotePlaceForPath(path);
  return at ? place.placeFsRead(at, path) : api.readFile(path);
}

export function writeFile(path: string, contents: string): Promise<void> {
  const at = remotePlaceForPath(path);
  return at
    ? place.placeFsWrite(at, path, contents)
    : api.writeFile(path, contents);
}

export function fsCreateFile(path: string): Promise<string> {
  const at = remotePlaceForPath(path);
  return at
    ? place.placeFsCreateFile(at, path)
    : api.fsCreateFile(path);
}

export function fsCreateFolder(path: string): Promise<string> {
  const at = remotePlaceForPath(path);
  return at
    ? place.placeFsCreateFolder(at, path)
    : api.fsCreateFolder(path);
}

/** Routed by where the thing being moved IS. A move that would cross from a
 *  machine to this laptop is not a rename, and the place refuses it as a path
 *  outside its project. */
export function fsRename(from: string, to: string): Promise<string> {
  const at = remotePlaceForPath(from);
  return at
    ? place.placeFsRename(at, from, to)
    : api.fsRename(from, to);
}

export function fsDelete(path: string): Promise<void> {
  const at = remotePlaceForPath(path);
  return at ? place.placeFsDelete(at, path) : api.fsDelete(path);
}

export function fsFindFiles(repoRoot: string): Promise<string[]> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeFsFindFiles(m) : api.fsFindFiles(repoRoot);
}

// ─── Reading git ─────────────────────────────────────────────────────────

export function gitStatusV2(repoRoot: string): Promise<GitStatusEntry[]> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitStatusV2(m) : api.gitStatusV2(repoRoot);
}

export function gitDiff(
  repoRoot: string,
  file: string,
  sinceBase?: boolean,
): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m
    ? place.placeGitDiff(m, file, sinceBase)
    : api.gitDiff(repoRoot, file, sinceBase);
}

export function gitDiffAtCommit(
  repoRoot: string,
  sha: string,
  file: string,
): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m
    ? place.placeGitDiffAtCommit(m, sha, file)
    : api.gitDiffAtCommit(repoRoot, sha, file);
}

export function gitDiffBase(
  repoRoot: string,
  base: string,
  file: string,
): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m
    ? place.placeGitDiffBase(m, base, file)
    : api.gitDiffBase(repoRoot, base, file);
}

export function gitDiffStatsPerFile(
  repoRoot: string,
  sinceBase?: boolean,
): Promise<FileDiffStat[]> {
  const m = remotePlaceForRoot(repoRoot);
  return m
    ? place.placeGitDiffStatsPerFile(m, sinceBase)
    : api.gitDiffStatsPerFile(repoRoot, sinceBase);
}

/** The footer's totals. A place has no separate totals command — the per-file
 *  numbers are the same `git diff --numstat` read, so they are summed here
 *  rather than sent for twice. */
export async function gitDiffStats(
  repoRoot: string,
  sinceBase?: boolean,
): Promise<DiffStats> {
  const m = remotePlaceForRoot(repoRoot);
  if (!m) return api.gitDiffStats(repoRoot, sinceBase);
  return sumStats(await place.placeGitDiffStatsPerFile(m, sinceBase));
}

export function sumStats(rows: FileDiffStat[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    added += r.additions;
    removed += r.deletions;
  }
  return { changed_files: rows.length, added, removed };
}

export function gitBranch(repoRoot: string): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitBranch(m) : api.gitBranch(repoRoot);
}

export function gitBranches(repoRoot: string): Promise<GitBranchInfo[]> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitBranches(m) : api.gitBranches(repoRoot);
}

export function gitBranchesRich(repoRoot: string): Promise<GitBranchRich[]> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitBranchesRich(m) : api.gitBranchesRich(repoRoot);
}

export function gitAheadBehind(repoRoot: string): Promise<AheadBehind> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitAheadBehind(m) : api.gitAheadBehind(repoRoot);
}

export function gitShowCommit(repoRoot: string, sha: string): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitShowCommit(m, sha) : api.gitShowCommit(repoRoot, sha);
}

export function gitShowHead(repoRoot: string, file: string): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitShowHead(m, file) : api.gitShowHead(repoRoot, file);
}

export function gitRemoteOrigin(repoRoot: string): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitRemoteOrigin(m) : api.gitRemoteOrigin(repoRoot);
}

/** The History rail's graph — `git log --all`, typed refs and all. */
export function gitCommitGraph(repoRoot: string, limit: number): Promise<GraphCommit[]> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitCommitGraph(m, limit) : api.gitCommitGraph(repoRoot, limit);
}

/** Whether the files, changes and git surfaces can open on `repoRoot` where
 *  it stands. Resolves to `null` when they can — always, on this laptop, where
 *  a missing folder is each pane's own error — and otherwise to the sentence
 *  the machine answered with: what `cd` or `git` said over there about the
 *  folder, so the empty state names the actual problem rather than a generic
 *  one. */
export async function workReady(repoRoot: string): Promise<string | null> {
  const m = remotePlaceForRoot(repoRoot);
  if (!m) return null;
  try {
    await place.placeWorkReady(m);
    return null;
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    return text.trim() || "The machine didn't say why the folder can't be opened.";
  }
}

// ─── Moving git ──────────────────────────────────────────────────────────

export function gitStage(repoRoot: string, paths: string[]): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitStage(m, paths) : api.gitStage(repoRoot, paths);
}

export function gitUnstage(repoRoot: string, paths: string[]): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitUnstage(m, paths) : api.gitUnstage(repoRoot, paths);
}

export function gitDiscard(repoRoot: string, paths: string[]): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitDiscard(m, paths) : api.gitDiscard(repoRoot, paths);
}

export function gitCommit(repoRoot: string, message: string): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitCommit(m, message) : api.gitCommit(repoRoot, message);
}

export function gitPush(repoRoot: string, setUpstream: boolean): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m
    ? place.placeGitPush(m, setUpstream)
    : api.gitPush(repoRoot, setUpstream);
}

export function gitPull(repoRoot: string): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitPull(m) : api.gitPull(repoRoot);
}

export function gitFetch(repoRoot: string): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitFetch(m) : api.gitFetch(repoRoot);
}

/** Pull, then push — what the local `git_sync` does, spelled out for a place
 *  as its two halves so a pull that stops on a conflict is reported as the
 *  pull it was, and nothing is pushed over it. */
export async function gitSync(repoRoot: string): Promise<string> {
  const m = remotePlaceForRoot(repoRoot);
  if (!m) return api.gitSync(repoRoot);
  const pulled = await place.placeGitPull(m);
  const pushed = await place.placeGitPush(m, false);
  return [pulled, pushed].filter((s) => s.trim()).join("\n");
}

/** The local twins answer nothing; the place ones answer git's own line,
 *  which no caller reads — both are void here so the surfaces stay one. */
export async function gitCheckout(repoRoot: string, branch: string): Promise<void> {
  const m = remotePlaceForRoot(repoRoot);
  if (m) await place.placeGitCheckout(m, branch);
  else await api.gitCheckout(repoRoot, branch);
}

export async function gitCreateBranch(repoRoot: string, name: string): Promise<void> {
  const m = remotePlaceForRoot(repoRoot);
  if (m) await place.placeGitCreateBranch(m, name);
  else await api.gitCreateBranch(repoRoot, name);
}

/** Every uncommitted change gone — tracked files back to the last commit,
 *  untracked ones removed. Resolves to how many files that touched. The
 *  local command has no `api` entry; it is the one `invoke` the reset flow
 *  made for itself, kept here so the two sides sit together. */
export function gitResetFiles(repoRoot: string): Promise<number> {
  const m = remotePlaceForRoot(repoRoot);
  return m ? place.placeGitResetFiles(m) : api.gitResetFiles(repoRoot);
}

/** Whether changes under `repoRoot` arrive by a file watcher (this laptop) or
 *  have to be asked for (a machine — nothing here can watch its disk). A
 *  surface that refreshes on `watch_repo` events polls instead when this is
 *  true; see `useGitChanges`. */
export function needsPolling(repoRoot: string | null | undefined): boolean {
  return machineIdForRoot(repoRoot) !== null;
}

// ─── Running the project (AURA-1307) ─────────────────────────────────────

/** "How do I run this?" — asked of the checkout where it stands. The same
 *  sniffer reads `package.json`, the Makefile and the rest; on a machine the
 *  files come back in one scripted answer instead of off this disk. */
export function runDetect(repoRoot: string): Promise<RunSuggestion> {
  const m = remotePlaceForRoot(repoRoot);
  return m
    ? api.placeRunDetect(m.machineId, m.repoRoot, m.remoteRoot ?? null)
    : api.runDetect(repoRoot);
}
