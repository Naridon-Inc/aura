// How a list of changed files becomes the Changes tab's groups: real edits
// split from machine churn, then either one list of every changed file (the
// rail) or Staged / Changes (the Git view, whose commit box commits what is
// staged), with Generated & ignored folded away under both.

import { isNoisePath } from "@shared/categorizeChange";
import type { ChangedFile } from "../../lib/useGitChanges";
import type { ChangeGroup } from "./ChangesTree";
import type { ChangeMode } from "./changeNodes";

export type ChangeParts = {
  sigStaged: ChangedFile[];
  sigUnstaged: ChangedFile[];
  sigUntracked: ChangedFile[];
  /** Machine churn, each file carrying the git state its row acts on. */
  noise: { file: ChangedFile; mode: ChangeMode }[];
  signalCount: number;
  noiseCount: number;
};

/** Split each git-state bucket into the files the user cares about (signal,
 *  real edits) and machine churn (noise: `.aura/**` snapshots, build output,
 *  editor cruft), which is clubbed into one collapsed group. */
export function splitChanges(
  staged: ChangedFile[],
  unstaged: ChangedFile[],
  untracked: ChangedFile[],
): ChangeParts {
  const sigStaged = staged.filter((f) => !isNoisePath(f.path));
  const sigUnstaged = unstaged.filter((f) => !isNoisePath(f.path));
  const sigUntracked = untracked.filter((f) => !isNoisePath(f.path));
  const noise: { file: ChangedFile; mode: ChangeMode }[] = [];
  const seen = new Set<string>();
  const collect = (list: ChangedFile[], mode: ChangeMode) => {
    for (const f of list) {
      if (!isNoisePath(f.path)) continue;
      const key = `${mode}:${f.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      noise.push({ file: f, mode });
    }
  };
  collect(staged, "staged");
  collect(unstaged, "unstaged");
  collect(untracked, "untracked");
  const signalPaths = new Set<string>();
  for (const f of [...sigStaged, ...sigUnstaged, ...sigUntracked]) signalPaths.add(f.path);
  return {
    sigStaged,
    sigUnstaged,
    sigUntracked,
    noise,
    signalCount: signalPaths.size,
    noiseCount: new Set(noise.map((n) => n.file.path)).size,
  };
}

type Entry = { file: ChangedFile; mode: ChangeMode };

/** Each path once, in path order with case ignored — how a diff lists its
 *  files. The first entry for a path wins. */
function onePerPath(entries: Entry[]): Entry[] {
  const byPath = new Map<string, Entry>();
  for (const entry of entries) if (!byPath.has(entry.file.path)) byPath.set(entry.file.path, entry);
  const key = (e: Entry) => e.file.path.toLowerCase();
  return [...byPath.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** The rail's groups: every changed file once, the way a diff reads, with no
 *  Staged / Changes split and no bulk action — committing is the git status
 *  row's job. A file staged and then edited again (`MM`) is one row acting on
 *  the working copy; a file only staged keeps its Unstage. Machine churn still
 *  folds into one collapsed group at the end. */
export function flatChangeGroups(
  parts: ChangeParts,
  opts: { generatedOpen: boolean; toggleGenerated: () => void },
): ChangeGroup[] {
  const files = onePerPath([
    ...parts.sigUntracked.map((file) => ({ file, mode: "untracked" as const })),
    ...parts.sigUnstaged.map((file) => ({ file, mode: "unstaged" as const })),
    ...parts.sigStaged.map((file) => ({ file, mode: "staged" as const })),
  ]);
  const groups: ChangeGroup[] = [{ key: "working", files }];
  if (parts.noise.length > 0) {
    groups.push({
      key: "generated",
      title: "Generated & ignored",
      files: onePerPath(parts.noise),
      collapsed: !opts.generatedOpen,
      onToggle: opts.toggleGenerated,
    });
  }
  return groups;
}

/** The Git view's groups: Staged and Changes with their bulk actions. */
export function buildChangeGroups(
  parts: ChangeParts,
  opts: {
    stage: (paths: string[]) => void;
    unstage: (paths: string[]) => void;
    generatedOpen: boolean;
    toggleGenerated: () => void;
  },
): ChangeGroup[] {
  const staged = parts.sigStaged.map((file) => ({ file, mode: "staged" as const }));
  const working = [
    ...parts.sigUnstaged.map((file) => ({ file, mode: "unstaged" as const })),
    ...parts.sigUntracked.map((file) => ({ file, mode: "untracked" as const })),
  ];
  const groups: ChangeGroup[] = [];
  if (staged.length > 0) {
    groups.push({
      key: "staged",
      title: "Staged",
      files: staged,
      action: { label: "Unstage all", run: () => opts.unstage(staged.map((e) => e.file.path)) },
    });
  }
  groups.push({
    key: "working",
    title: staged.length > 0 ? "Changes" : undefined,
    files: working,
    action: { label: "Stage all", run: () => opts.stage(working.map((e) => e.file.path)) },
  });
  if (parts.noise.length > 0) {
    // Staging churn is deliberate, per file — no bulk action here.
    groups.push({
      key: "generated",
      title: "Generated & ignored",
      files: parts.noise,
      collapsed: !opts.generatedOpen,
      onToggle: opts.toggleGenerated,
    });
  }
  return groups;
}

/** Which git state a selected path's row is in, for the tree's highlight. */
export function selectedModeFor(
  selected: string | null,
  staged: ChangedFile[],
  unstaged: ChangedFile[],
  untracked: ChangedFile[],
): ChangeMode {
  if (staged.some((f) => f.path === selected) && !unstaged.some((f) => f.path === selected)) return "staged";
  if (untracked.some((f) => f.path === selected)) return "untracked";
  return "unstaged";
}
