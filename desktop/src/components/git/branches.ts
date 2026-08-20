// Shared branch engine — the one place "which branch am I on / switch / create"
// is driven, so every branch control in the app behaves identically. The Git
// view's header menu drives git through this hook; the footer BranchSwitcher
// shares this file's `humanizeGitError` so a checkout failure reads the same
// human sentence wherever it surfaces. Pure logic, no JSX — each surface paints
// its own chrome over the same state machine.

import { useEffect, useState } from "react";
import { api, type GitBranchInfo } from "../../lib/api";

export interface UseBranches {
  /** Current branch name (null for detached HEAD / non-repo). */
  current: string | null;
  branches: GitBranchInfo[];
  loading: boolean;
  /** Name of the branch a checkout/create is in flight for, else null. */
  busy: string | null;
  error: string | null;
  setError: (e: string | null) => void;
  /** (Re)load the local + remote branch list. Call when a menu opens. */
  loadBranches: () => Promise<void>;
  /** Check out an existing branch. Returns true on success so the caller
   *  can close its menu; a remote ref (`origin/x`) DWIMs to a tracking
   *  branch in the Rust layer. */
  checkout: (name: string) => Promise<boolean>;
  /** Create + switch to a new branch from HEAD. Returns true on success. */
  createBranch: (name: string) => Promise<boolean>;
}

/** Branch state for one surface. `poll: true` keeps the current-branch chip
 *  honest when the branch changes outside this control (terminal checkout,
 *  an agent, the footer) by re-reading every 5s; a transient surface that
 *  opens fresh each time can leave it off. */
export function useBranches(
  repoRoot: string,
  opts: { poll?: boolean } = {},
): UseBranches {
  const poll = opts.poll ?? false;
  const [current, setCurrent] = useState<string | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoRoot) {
      setCurrent(null);
      return;
    }
    let cancelled = false;
    const read = async () => {
      try {
        const b = (await api.gitBranch(repoRoot)).trim();
        if (!cancelled) setCurrent(b || null);
      } catch {
        if (!cancelled) setCurrent(null);
      }
    };
    void read();
    if (!poll) return () => void (cancelled = true);
    const id = window.setInterval(read, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, poll]);

  async function loadBranches() {
    if (!repoRoot) return;
    setLoading(true);
    setError(null);
    try {
      setBranches(await api.gitBranches(repoRoot));
    } catch (e) {
      setError(humanizeGitError(String(e)));
    } finally {
      setLoading(false);
    }
  }

  async function checkout(name: string): Promise<boolean> {
    if (busy) return false;
    setBusy(name);
    setError(null);
    try {
      await api.gitCheckout(repoRoot, name);
      // Optimistically reflect the switch; the poll (when on) confirms it.
      setCurrent(name.replace(/^origin\//, ""));
      // Tell every git pane (Changes / diff / summary / history) to re-read —
      // a checkout changes the working tree out from under them.
      window.dispatchEvent(new CustomEvent("aura:git-changed"));
      return true;
    } catch (e) {
      setError(humanizeGitError(String(e)));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function createBranch(rawName: string): Promise<boolean> {
    const name = rawName.trim();
    if (!name || busy) return false;
    setBusy(name);
    setError(null);
    try {
      await api.gitCreateBranch(repoRoot, name);
      setCurrent(name);
      window.dispatchEvent(new CustomEvent("aura:git-changed"));
      return true;
    } catch (e) {
      setError(humanizeGitError(String(e)));
      return false;
    } finally {
      setBusy(null);
    }
  }

  return {
    current,
    branches,
    loading,
    busy,
    error,
    setError,
    loadBranches,
    checkout,
    createBranch,
  };
}

// Turn raw `git` stderr into a one-line, human-readable reason. Falls back to
// the first line of whatever git said so we never swallow detail. Shared with
// the footer BranchSwitcher so the same failure reads identically everywhere.
export function humanizeGitError(raw: string): string {
  const s = raw.replace(/^Error:\s*/i, "").trim();
  // Worktree-heavy setups hit this constantly: a branch can only be checked
  // out in one worktree at a time. Git's raw "fatal: 'x' is already checked
  // out at <path>" reads like a crash — translate it.
  if (/already checked out|already used by worktree|is already used by/i.test(s)) {
    const at = s.match(/at '([^']+)'/);
    return at
      ? `Already open in another parallel copy (${at[1]}). Switch to that copy instead.`
      : "That branch is open in another parallel copy. Switch to that copy instead.";
  }
  if (/would be overwritten|local changes|commit your changes or stash/i.test(s))
    return "You have changes here you haven't committed yet. They'd be overwritten. Commit them first, then switch.";
  if (/did not match any|unknown revision|invalid reference|pathspec/i.test(s))
    return "Branch not found.";
  if (/already exists/i.test(s)) return "A branch with that name already exists.";
  if (/not a git repository/i.test(s)) return "This folder isn't tracked yet.";
  return s.split("\n")[0] || "Git error.";
}
