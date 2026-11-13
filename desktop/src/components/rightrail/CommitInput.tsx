// Commit + sync surface at the foot of the details panel's Changes tab. One
// message box and one button that does what the branch needs next:
//
//   staged + msg     → "Commit"
//   ahead && behind  → "Sync"
//   ahead only       → "Push"
//   behind only      → "Pull"
//   no upstream      → "Publish branch"
//
// The chevron beside it lists every variant (Commit, Commit and push, Push,
// Pull, Sync, Fetch). ⌘↩ runs the current primary action.
//
// Where the branch stands (name, ahead/behind, unpublished) is the panel
// toolbar's job, one row up, so this box doesn't repeat it.
//
// Polls `git_ahead_behind` on a 6s timer + every time the parent's
// `refreshTick` increments (after a commit/stage round-trip), so the
// label updates near-instantly after pushes/pulls without a full reload.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AheadBehind, type RadarCollision } from "../../lib/api";
import { fetchAheadBehind } from "../../lib/gitStateCache";
// Through the place seam: a workspace standing in a machine commits and
// pushes the box's checkout, not the laptop's copy (AURA-1306).
import {
  gitCommit,
  gitFetch,
  gitPull,
  gitPush,
  gitSync,
} from "../../lib/place/workApi";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";
import { usePanelActive } from "../../lib/panelActive";
import { ShellNotice } from "../ui/shell-notice";
import { Textarea } from "../ui/textarea";
import "../ui/details-commit.css";
import { CommitActionButton } from "./commit/CommitActionButton";
import { CommitRadarNotice } from "./commit/CommitRadarNotice";
import { getPrimaryAction, type PrimaryActionType } from "./getPrimaryAction";
import { ShipReadyPill } from "./ShipReadyPill";

const POLL_MS = 6000;
// AURA-19 — pre-commit awareness consult. The radar answers in well under a
// second locally; if it's slower than this (or errors) we commit anyway —
// awareness must never gate the user's own commit.
const RADAR_TIMEOUT_MS = 1500;

type Props = {
  repoRoot: string;
  hasStagedChanges: boolean;
  /** Increment to force an immediate `git_ahead_behind` re-poll without
   *  waiting for the 6s tick. Parent bumps this after stage/commit. */
  refreshTick: number;
  /** Optional strict-mode gate before commit actions. */
  onBeforeCommit?: () => Promise<boolean>;
  onAfterMutation: () => void;
  /** A live sync session is running — the tree already syncs continuously,
   *  so a commit/push is an explicit *snapshot*, not the way changes reach
   *  teammates. Shows a one-line caption; git behavior is unchanged. */
  liveActive?: boolean;
};

export function CommitInput({
  repoRoot,
  hasStagedChanges,
  refreshTick,
  onBeforeCommit,
  onAfterMutation,
  liveActive = false,
}: Props) {
  const [msg, setMsg] = useState("");
  const [pending, setPending] = useState<PrimaryActionType | "fetch" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [ahead, setAhead] = useState<AheadBehind>({
    ahead: 0,
    behind: 0,
    has_upstream: false,
    branch: null,
  });
  // The seed above is a valid AheadBehind meaning "never published", so until
  // this flips true every reading of it is a fabrication — and the chip below
  // used to print an amber "unpublished" from it, on the first frame and
  // forever after a failed read.
  const [aheadRead, setAheadRead] = useState(false);
  const visible = useDocumentVisibility();
  // Parked: the rail keeps this panel mounted behind another tab so a
  // half-typed message survives the trip. Mounted is not on screen, and a
  // panel nobody can see has no reason to keep asking git anything.
  const panelActive = usePanelActive();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // AURA-19 — awareness card state. `radarWarnings` non-null renders the
  // card; the ref remembers which action the user was attempting so
  // "Commit anyway" resumes it (and the resumed call skips the re-check).
  // Acknowledgment is per-click: the next commit consults the radar fresh.
  const [radarWarnings, setRadarWarnings] = useState<RadarCollision[] | null>(
    null,
  );
  const pendingRadarRef = useRef<"commit" | "commit-push" | null>(null);

  // Auto-clear toasts so the panel doesn't accumulate stale rows.
  useEffect(() => {
    if (!info && !error) return;
    const id = window.setTimeout(() => {
      setInfo(null);
      setError(null);
    }, 4000);
    return () => window.clearTimeout(id);
  }, [info, error]);

  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    async function tick() {
      try {
        const ab = await fetchAheadBehind(repoRoot);
        if (!cancelled) {
          setAhead(ab);
          setAheadRead(true);
        }
      } catch {
        // Non-fatal, but NOT "no upstream": that was this catch's old excuse,
        // and it made a failed git call indistinguishable from a branch
        // nobody had pushed. `aheadRead` stays false and the chip says so.
      }
    }
    void tick();
    if (!visible || !panelActive)
      return () => {
        cancelled = true;
      };
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, visible, panelActive, refreshTick]);

  const canCommit = hasStagedChanges && msg.trim().length > 0;
  const isPending = pending !== null;

  const primary = useMemo(
    () =>
      getPrimaryAction({
        canCommit,
        hasStagedChanges,
        isPending,
        pushCount: ahead.ahead,
        pullCount: ahead.behind,
        hasUpstream: ahead.has_upstream,
        known: aheadRead,
      }),
    [canCommit, hasStagedChanges, isPending, ahead, aheadRead],
  );

  const runAfter = useCallback(() => {
    onAfterMutation();
    // Immediate refresh of ahead/behind too — onAfterMutation bumps
    // refreshTick but the effect runs in the next microtask.
    void api
      .gitAheadBehind(repoRoot)
      .then((ab) => {
        setAhead(ab);
        setAheadRead(true);
      })
      .catch(() => {});
    // Broadcast so the rest of the git UI re-reads after a commit / push /
    // pull / sync — the History list re-loads, the working-diff pane refreshes,
    // and the footer branch chip re-polls. One signal, every pane listens.
    window.dispatchEvent(new CustomEvent("aura:git-changed"));
  }, [onAfterMutation, repoRoot]);

  // One-shot radar consult at commit time. Conflicts arrive pre-scored
  // against MY in-flight work (the CLI does the scoring and excludes
  // self-authored events); we only surface direct/likely — `possible` is
  // too speculative to interrupt a commit for.
  const radarConflicts = useCallback(async (): Promise<RadarCollision[]> => {
    try {
      const view = await Promise.race([
        api.auraRadar(repoRoot, false),
        new Promise<null>((resolve) =>
          window.setTimeout(() => resolve(null), RADAR_TIMEOUT_MS),
        ),
      ]);
      if (!view) return [];
      return (view.conflicts ?? []).filter(
        (c) => c.severity === "direct" || c.severity === "likely",
      );
    } catch {
      // Old bundled CLI / no .aura — awareness simply doesn't exist here.
      return [];
    }
  }, [repoRoot]);

  const doCommit = useCallback(async () => {
    if (!canCommit) return;
    if (pendingRadarRef.current !== "commit") {
      setPending("commit");
      const conflicts = await radarConflicts();
      setPending(null);
      if (conflicts.length > 0) {
        pendingRadarRef.current = "commit";
        setRadarWarnings(conflicts);
        return;
      }
    }
    pendingRadarRef.current = null;
    setRadarWarnings(null);
    if (onBeforeCommit && !(await onBeforeCommit())) return;
    setPending("commit");
    try {
      await gitCommit(repoRoot, msg.trim());
      setMsg("");
      setInfo("Committed");
      runAfter();
    } catch (e) {
      setError(`Commit failed: ${e}`);
    } finally {
      setPending(null);
    }
  }, [canCommit, repoRoot, msg, runAfter, onBeforeCommit, radarConflicts]);

  const doPush = useCallback(
    async (setUpstream = false) => {
      setPending("push");
      try {
        await gitPush(repoRoot, setUpstream || !ahead.has_upstream);
        setInfo(setUpstream || !ahead.has_upstream ? "Published" : "Pushed");
        runAfter();
      } catch (e) {
        setError(`Push failed: ${e}`);
      } finally {
        setPending(null);
      }
    },
    [repoRoot, ahead.has_upstream, runAfter],
  );

  const doPull = useCallback(async () => {
    setPending("pull");
    try {
      await gitPull(repoRoot);
      setInfo("Pulled");
      runAfter();
    } catch (e) {
      setError(`Pull failed: ${e}`);
    } finally {
      setPending(null);
    }
  }, [repoRoot, runAfter]);

  const doSync = useCallback(async () => {
    setPending("sync");
    try {
      await gitSync(repoRoot);
      setInfo("Synced");
      runAfter();
    } catch (e) {
      setError(`Sync failed: ${e}`);
    } finally {
      setPending(null);
    }
  }, [repoRoot, runAfter]);

  const doFetch = useCallback(async () => {
    setPending("fetch");
    try {
      await gitFetch(repoRoot);
      setInfo("Checked");
      runAfter();
    } catch (e) {
      setError(`Couldn't check for updates: ${e}`);
    } finally {
      setPending(null);
    }
  }, [repoRoot, runAfter]);

  const doCommitAndPush = useCallback(async () => {
    if (!canCommit) return;
    if (pendingRadarRef.current !== "commit-push") {
      setPending("commit");
      const conflicts = await radarConflicts();
      setPending(null);
      if (conflicts.length > 0) {
        pendingRadarRef.current = "commit-push";
        setRadarWarnings(conflicts);
        return;
      }
    }
    pendingRadarRef.current = null;
    setRadarWarnings(null);
    if (onBeforeCommit && !(await onBeforeCommit())) return;
    setPending("commit");
    try {
      await gitCommit(repoRoot, msg.trim());
      setMsg("");
      setInfo("Committed");
      // Don't await refresh tick — push directly.
      await gitPush(repoRoot, !ahead.has_upstream);
      setInfo("Committed & pushed");
      runAfter();
    } catch (e) {
      setError(`Commit & push failed: ${e}`);
    } finally {
      setPending(null);
    }
  }, [
    canCommit,
    repoRoot,
    msg,
    ahead.has_upstream,
    runAfter,
    onBeforeCommit,
    radarConflicts,
  ]);

  // "Commit anyway" — resume the action the card interrupted. The ref is
  // left set so the resumed call skips the radar re-check, then clears it.
  const resumeAfterRadar = useCallback(() => {
    const action = pendingRadarRef.current;
    setRadarWarnings(null);
    if (action === "commit") void doCommit();
    else if (action === "commit-push") void doCommitAndPush();
  }, [doCommit, doCommitAndPush]);

  const dismissRadar = useCallback(() => {
    pendingRadarRef.current = null;
    setRadarWarnings(null);
  }, []);

  const handlePrimary = useCallback(() => {
    switch (primary.action) {
      case "commit":
        return doCommit();
      case "push":
        return doPush(false);
      case "pull":
        return doPull();
      case "sync":
        return doSync();
      case "publish":
        return doPush(true);
    }
  }, [primary.action, doCommit, doPush, doPull, doSync]);

  return (
    <div className="ui-details-commit">
      {liveActive && (
        <div className="ui-details-commit-live">
          <span>Live. Changes sync automatically. Commit publishes a snapshot.</span>
        </div>
      )}

      {(info || error) && (
        <ShellNotice tone={error ? "error" : "ok"}>{error ?? info}</ShellNotice>
      )}

      {radarWarnings && radarWarnings.length > 0 && (
        <CommitRadarNotice
          warnings={radarWarnings}
          onCommitAnyway={resumeAfterRadar}
          onReviewFirst={dismissRadar}
        />
      )}

      <Textarea
        ref={taRef}
        value={msg}
        onChange={(e) => setMsg(e.target.value)}
        placeholder={
          hasStagedChanges ? "Commit message (⌘↩ to commit)" : "Stage changes to commit"
        }
        aria-label="Commit message"
        disabled={isPending}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !primary.disabled) {
            e.preventDefault();
            handlePrimary();
          }
        }}
      />

      <div className="ui-details-commit-actions">
        <CommitActionButton
          primary={primary}
          ahead={ahead}
          aheadRead={aheadRead}
          canCommit={canCommit}
          busy={isPending}
          onPrimary={handlePrimary}
          onCommit={doCommit}
          onCommitAndPush={doCommitAndPush}
          onPush={() => doPush(false)}
          onPull={doPull}
          onSync={doSync}
          onFetch={doFetch}
        />
        {/* Ambient ship-readiness — live fast-gate status right where you
            commit. Click opens the full detail on Checks. */}
        <ShipReadyPill repoRoot={repoRoot} />
      </div>
    </div>
  );
}
