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

import { useEffect, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";

import { api, type AheadBehind } from "../../lib/api";
import { Button } from "../ui/button";
import { useBranches } from "./branches";
import { BranchSwitcherModal } from "./BranchSwitcherModal";

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
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-soft bg-bg-1/60 px-2.5 text-[12px] text-text-1 transition-colors hover:bg-bg-2"
        title="Current branch — click to switch or create"
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
  const [ab, setAb] = useState<AheadBehind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setAb(await api.gitAheadBehind(repoRoot));
    } catch {
      setAb(null);
    }
  }

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 15000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot]);

  // The single right action for the current state, in plain words.
  const action = pickSyncAction(ab);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (action.kind === "publish") await api.gitPush(repoRoot, true);
      else if (action.kind === "push") await api.gitPush(repoRoot, false);
      else if (action.kind === "pull") await api.gitPull(repoRoot);
      else if (action.kind === "sync") await api.gitSync(repoRoot);
      else await api.gitFetch(repoRoot);
      await refresh();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/i, "").split("\n")[0]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      {ab && (ab.ahead > 0 || ab.behind > 0) && (
        <span
          className="inline-flex items-center gap-1 rounded-md border border-line-soft bg-bg-1/60 px-1.5 py-1 text-[10.5px] tabular-nums text-text-3"
          title={`${ab.ahead} ahead · ${ab.behind} behind upstream`}
        >
          {ab.ahead > 0 && <span>↑{ab.ahead}</span>}
          {ab.behind > 0 && <span>↓{ab.behind}</span>}
        </span>
      )}
      <Button
        size="sm"
        variant="subtle"
        onClick={() => void run()}
        disabled={busy}
        title={action.hint}
      >
        <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
        {busy ? "Working…" : action.label}
      </Button>
      {error && (
        <span className="max-w-[200px] truncate text-[10.5px] text-red" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

type SyncAction = {
  kind: "publish" | "push" | "pull" | "sync" | "fetch";
  label: string;
  hint: string;
};

function pickSyncAction(ab: AheadBehind | null): SyncAction {
  if (!ab || !ab.has_upstream)
    return {
      kind: "publish",
      label: "Publish",
      hint: "This branch only lives on your machine — publish it so teammates (and the server) can see it.",
    };
  if (ab.ahead > 0 && ab.behind > 0)
    return {
      kind: "sync",
      label: "Sync",
      hint: "You have changes to send and changes to receive — sync does both.",
    };
  if (ab.ahead > 0)
    return {
      kind: "push",
      label: "Push",
      hint: "Send your saved changes up to the shared copy.",
    };
  if (ab.behind > 0)
    return {
      kind: "pull",
      label: "Pull",
      hint: "Bring down changes others have shared.",
    };
  return {
    kind: "fetch",
    label: "Check",
    hint: "You're in step with the shared copy — check for anything new.",
  };
}

function Caret() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" className="text-text-4">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}
