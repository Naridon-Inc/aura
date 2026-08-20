// RepoHeaderControls — the branch + sync cluster that lives in the Git view's
// top bar, visible on both tabs so "where am I / switch / publish / catch up"
// is always one reach away (not buried in a sidebar, the thing the old view
// got wrong). Two controls:
//
//   • BranchMenu  — current branch + a downward popover to filter, create, and
//     check out, driven by the shared `useBranches` engine so it behaves like
//     the footer switcher.
//   • SyncControl — ahead/behind vs the upstream, with the one right action:
//     Publish (no upstream), Sync (both ahead & behind), Push (ahead only),
//     Pull (behind only), or Fetch (in step). Plain words, no git verbs bare.
//     Which of those it offers is decided by `syncAction`, in `reviewState` —
//     including the two it never used to have, for "we haven't read this yet"
//     and "the read failed". Both of those used to land on Publish.

import { useEffect, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";

import { api } from "../../lib/api";
import { fetchAheadBehind, invalidateGitState } from "../../lib/gitStateCache";
import { Button } from "../ui/button";
import { useBranches } from "./branches";
import { BranchSwitcherModal } from "./BranchSwitcherModal";
import {
  branchSyncDetail,
  syncAction,
  type BranchRead,
} from "../rightrail/reviewState";

export function RepoHeaderControls({ repoRoot }: { repoRoot: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <BranchMenu repoRoot={repoRoot} />
      <SyncControl repoRoot={repoRoot} />
    </div>
  );
}

// ── Branch ───────────────────────────────────────────────────────────
// The trigger only reads the current branch; clicking it opens the rich
// Cmd-K-style BranchSwitcherModal (over the full-screen Git overlay), which
// owns the list, filter, presence, and create-from-here.

function BranchMenu({ repoRoot }: { repoRoot: string }) {
  const br = useBranches(repoRoot, { poll: true });
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-soft bg-bg-1/60 px-2.5 text-sm text-text-1 transition-colors hover:bg-state-hover"
        title="Current branch. Click to switch or create"
      >
        <GitBranch size={13} className="shrink-0 text-text-3" />
        <span className="max-w-[180px] truncate font-medium">
          {br.current ?? "—"}
        </span>
        <Caret />
      </button>

      {open && (
        <BranchSwitcherModal repoRoot={repoRoot} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

// ── Sync ─────────────────────────────────────────────────────────────

function SyncControl({ repoRoot }: { repoRoot: string }) {
  // `read` is a union, not `AheadBehind | null`. The null it replaced meant
  // "haven't looked yet" on the first paint and "the read threw" thereafter,
  // and `pickSyncAction` turned both into a Publish button over the words
  // "this branch only lives on your machine" — which, when pressed, ran
  // `git push --set-upstream` on a branch that very likely already had one.
  const [read, setRead] = useState<BranchRead>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      // Shared with the commit box and the checks panel, which ask the same
      // question about the same repo on their own timers — see gitStateCache.
      // This header polls every 15s and never unmounts, so it is the one that
      // runs whether or not anybody is looking at it.
      const ab = await fetchAheadBehind(repoRoot);
      setRead({
        status: "ready",
        ahead: ab.ahead,
        behind: ab.behind,
        hasUpstream: ab.has_upstream,
      });
    } catch (e) {
      setRead({
        status: "error",
        message: String(e).replace(/^Error:\s*/i, "").split("\n")[0],
      });
    }
  }

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 15000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot]);

  // The single right action for the current state, in plain words. Pure and
  // tested — see `syncAction`.
  const action = syncAction(read);
  const ready = read.status === "ready" ? read : null;

  async function run() {
    if (busy || action.idle) return;
    setBusy(true);
    setError(null);
    try {
      if (action.kind === "publish") await api.gitPush(repoRoot, true);
      else if (action.kind === "push") await api.gitPush(repoRoot, false);
      else if (action.kind === "pull") await api.gitPull(repoRoot);
      else if (action.kind === "sync") await api.gitSync(repoRoot);
      // "retry" falls here too: re-reading is exactly what it offers, and
      // `git fetch` doesn't move anything.
      else await api.gitFetch(repoRoot);
      // We just moved the thing the cache remembers, so drop it before asking:
      // a shared answer from a second ago describes the branch as it was before
      // this button pressed, and this refresh is the one the user is watching
      // for confirmation that it worked.
      invalidateGitState();
      await refresh();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/i, "").split("\n")[0]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      {ready && (ready.ahead > 0 || ready.behind > 0) && (
        // Same chip, same one explanation — see `branchSyncDetail`. This
        // header and the branch switcher both drew two arrows and then each
        // wrote its own hover for them.
        //
        // `hasUpstream` used to be the literal `true` here. A branch with no
        // upstream still reports commits, so the hover explained arrows on a
        // never-published branch by talking about the upstream they weren't
        // counted against.
        <span
          className="inline-flex items-center gap-1 rounded-md border border-line-soft bg-bg-1/60 px-1.5 py-1 text-xs tabular-nums text-text-3"
          title={branchSyncDetail(ready.ahead, ready.behind, ready.hasUpstream)}
        >
          {ready.ahead > 0 && <span>↑{ready.ahead}</span>}
          {ready.behind > 0 && <span>↓{ready.behind}</span>}
        </span>
      )}
      <Button
        size="sm"
        variant="subtle"
        onClick={() => void run()}
        disabled={busy || action.idle}
        title={action.hint}
      >
        <RefreshCw
          size={12}
          className={busy || action.idle ? "animate-spin" : ""}
        />
        {busy ? "Working…" : action.label}
      </Button>
      {error && (
        <span className="max-w-[200px] truncate text-xs text-red" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

function Caret() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" className="text-text-4">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}
