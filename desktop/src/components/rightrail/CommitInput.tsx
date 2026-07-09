// Commit + sync surface mounted at the bottom of the Source Control
// Changes panel. Single textarea + a morphing primary button:
//
//   staged + msg     → "Commit"
//   ahead && behind  → "Sync"
//   ahead only       → "Push"
//   behind only      → "Pull"
//   no upstream      → "Publish branch"
//
// Chevron next to the primary button drops a menu with every variant
// (Commit, Commit & Push, Push, Pull, Sync, Fetch). ⌘+Enter triggers
// the current primary action — same shortcut Superset uses, no learning
// cost for users coming from there.
//
// Polls `git_ahead_behind` on a 6s timer + every time the parent's
// `refreshTick` increments (after a commit/stage round-trip), so the
// label updates near-instantly after pushes/pulls without a full reload.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AheadBehind, type RadarCollision } from "../../lib/api";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { actorShort, agoFromMs, severityMeta } from "./radar/radarFormat";
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
  const visible = useDocumentVisibility();
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
        const ab = await api.gitAheadBehind(repoRoot);
        if (!cancelled) setAhead(ab);
      } catch {
        // Non-fatal — branch chip just shows no upstream.
      }
    }
    void tick();
    if (!visible) return () => {
      cancelled = true;
    };
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, visible, refreshTick]);

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
      }),
    [canCommit, hasStagedChanges, isPending, ahead],
  );

  const runAfter = useCallback(() => {
    onAfterMutation();
    // Immediate refresh of ahead/behind too — onAfterMutation bumps
    // refreshTick but the effect runs in the next microtask.
    void api
      .gitAheadBehind(repoRoot)
      .then(setAhead)
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
      await api.gitCommit(repoRoot, msg.trim());
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
        await api.gitPush(repoRoot, setUpstream || !ahead.has_upstream);
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
      await api.gitPull(repoRoot);
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
      await api.gitSync(repoRoot);
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
      await api.gitFetch(repoRoot);
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
      await api.gitCommit(repoRoot, msg.trim());
      setMsg("");
      setInfo("Committed");
      // Don't await refresh tick — push directly.
      await api.gitPush(repoRoot, !ahead.has_upstream);
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
    <div className="border-t border-line-soft bg-bg-1/30 shrink-0">
      {liveActive && (
        <div className="px-3 py-1.5 flex items-center gap-1.5 text-[10px] text-text-4 border-b border-line-soft">
          <span
            className="h-[6px] w-[6px] rounded-full bg-accent-green shrink-0"
            aria-hidden
          />
          <span className="truncate">
            Live — changes sync automatically. Commit publishes a snapshot.
          </span>
        </div>
      )}
      {/* Branch chip + ahead/behind glyphs */}
      <div className="px-3 py-1.5 flex items-center gap-2 text-[10.5px] text-text-3">
        <BranchGlyph />
        <span className="font-mono text-text-2 truncate max-w-[160px]">
          {ahead.branch ?? "no branch"}
        </span>
        {ahead.has_upstream ? (
          <>
            {ahead.ahead > 0 && (
              <span className="flex items-center gap-0.5 text-text-2 tabular-nums">
                <ArrowUpGlyph />
                {ahead.ahead}
              </span>
            )}
            {ahead.behind > 0 && (
              <span className="flex items-center gap-0.5 text-text-2 tabular-nums">
                <ArrowDownGlyph />
                {ahead.behind}
              </span>
            )}
            {ahead.ahead === 0 && ahead.behind === 0 && (
              <span className="text-text-4">in sync</span>
            )}
          </>
        ) : (
          <span
            className="text-amber"
            title="This branch only lives on your machine — Publish it to share."
          >
            unpublished
          </span>
        )}
        <div className="ml-auto flex items-center gap-2.5">
          {/* Ambient ship-readiness — live fast-gate status right where you
              commit. Click opens the full detail (ChecksPane). */}
          <ShipReadyPill repoRoot={repoRoot} />
          <button
            type="button"
            onClick={doFetch}
            disabled={isPending}
            className="text-text-3 hover:text-text-1 transition-colors disabled:opacity-50"
            title="Check for new commits from teammates"
          >
            check
          </button>
        </div>
      </div>

      {(info || error) && (
        <div
          className={`px-3 py-1 text-[10.5px] border-t border-line-soft ${
            error ? "bg-red/10 text-red" : "bg-green/10 text-green"
          }`}
        >
          {error ?? info}
        </div>
      )}

      {/* AURA-19 — awareness card: teammates/agents are in-flight on what
          you're about to commit. Informational, never blocking — "Commit
          anyway" resumes the interrupted action. */}
      {radarWarnings && radarWarnings.length > 0 && (
        <div className="mx-2 mt-2 rounded border border-line-soft bg-bg-0 overflow-hidden">
          <div className="px-2.5 py-1.5 flex items-center gap-1.5 text-[10.5px] text-text-2 border-b border-line-soft">
            <span className="font-medium">
              {radarWarnings.length === 1
                ? "A teammate is on this code"
                : `${radarWarnings.length} teammates are on this code`}
            </span>
            <button
              type="button"
              onClick={dismissRadar}
              className="ml-auto w-4 h-4 flex items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-bg-hover"
              title="Dismiss"
            >
              ×
            </button>
          </div>
          {radarWarnings.slice(0, 3).map((c) => {
            const meta = severityMeta(c.severity);
            return (
              <div
                key={c.event_id}
                className="px-2.5 py-1.5 flex items-start gap-1.5 text-[10.5px] text-text-3"
                title={[c.reason, c.their_intent].filter(Boolean).join("\n")}
              >
                <span
                  className="mt-1 block w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: meta.color }}
                />
                <span className="flex-1 min-w-0">
                  <span className="text-text-1">{actorShort(c.peer)}</span>
                  {c.peer_is_agent ? " (agent)" : ""} · {meta.disposition} —{" "}
                  <span className="font-mono text-text-2">
                    {c.their_symbol || c.their_file || "your in-flight files"}
                  </span>{" "}
                  · {agoFromMs(c.age_ms)}
                  {!c.same_branch && c.their_branch
                    ? ` on ${c.their_branch}`
                    : ""}
                </span>
              </div>
            );
          })}
          {radarWarnings.length > 3 && (
            <div className="px-2.5 pb-1.5 text-[10px] text-text-4">
              +{radarWarnings.length - 3} more in the Team Radar panel
            </div>
          )}
          <div className="px-2.5 py-1.5 flex items-center gap-1.5 border-t border-line-soft">
            <button
              type="button"
              onClick={resumeAfterRadar}
              className="h-6 px-2 rounded bg-bg-2 hover:bg-bg-1 text-text-1 text-[10.5px] font-medium border border-line-soft transition-colors"
            >
              Commit anyway
            </button>
            <button
              type="button"
              onClick={dismissRadar}
              className="h-6 px-2 rounded text-text-3 hover:text-text-1 text-[10.5px] transition-colors"
            >
              Review first
            </button>
          </div>
        </div>
      )}

      <div className="p-2 flex flex-col gap-1.5">
        <textarea
          ref={taRef}
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          placeholder={
            hasStagedChanges
              ? "Commit message (⌘↩ to commit)"
              : "Stage changes to commit"
          }
          disabled={isPending}
          className="w-full min-h-[52px] resize-y bg-bg-0 border border-line-soft rounded px-2 py-1.5 text-[11.5px] text-text-1 placeholder:text-text-4 focus:outline-none focus:border-text-3 transition-colors"
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              (e.metaKey || e.ctrlKey) &&
              !primary.disabled
            ) {
              e.preventDefault();
              handlePrimary();
            }
          }}
        />

        <div className="flex items-stretch gap-px">
          <button
            type="button"
            onClick={handlePrimary}
            disabled={primary.disabled}
            title={primary.tooltip}
            className="flex-1 h-7 rounded-l bg-bg-2 hover:bg-bg-1 active:bg-bg-2 disabled:opacity-50 disabled:cursor-not-allowed text-text-1 text-[11px] font-medium flex items-center justify-center gap-1.5 transition-colors border border-line-soft border-r-0"
          >
            <ActionGlyph action={primary.action} />
            <span>{primary.label}</span>
            {primary.action !== "commit" && primary.action !== "publish" && (
              <span className="text-[10px] text-text-3 tabular-nums">
                {primary.action === "push"
                  ? ahead.ahead
                  : primary.action === "pull"
                    ? ahead.behind
                    : `${ahead.behind}/${ahead.ahead}`}
              </span>
            )}
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={isPending}
                className="h-7 px-2 rounded-r bg-bg-2 hover:bg-bg-1 disabled:opacity-50 text-text-2 border border-line-soft transition-colors"
                aria-label="More commit actions"
              >
                <ChevronDownGlyph />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 text-[11.5px]">
              <DropdownMenuItem
                onSelect={doCommit}
                disabled={!canCommit}
                className="text-[11.5px]"
              >
                <CheckGlyph />
                Commit
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={doCommitAndPush}
                disabled={!canCommit}
                className="text-[11.5px]"
              >
                <ArrowUpGlyph />
                Commit & Push
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                onSelect={() => doPush(false)}
                disabled={ahead.ahead === 0 && ahead.has_upstream}
                className="text-[11.5px]"
              >
                <ArrowUpGlyph />
                <span className="flex-1">
                  {ahead.has_upstream ? "Push" : "Publish branch"}
                </span>
                {ahead.ahead > 0 && (
                  <span className="text-[10px] text-text-3 tabular-nums">
                    {ahead.ahead}
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={doPull}
                disabled={ahead.behind === 0}
                className="text-[11.5px]"
              >
                <ArrowDownGlyph />
                <span className="flex-1">Pull</span>
                {ahead.behind > 0 && (
                  <span className="text-[10px] text-text-3 tabular-nums">
                    {ahead.behind}
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={doSync}
                disabled={ahead.ahead === 0 && ahead.behind === 0}
                className="text-[11.5px]"
              >
                <SyncGlyph />
                Sync
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={doFetch} className="text-[11.5px]">
                <RefreshGlyph />
                Fetch
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

function ActionGlyph({ action }: { action: PrimaryActionType }) {
  if (action === "commit") return <CheckGlyph />;
  if (action === "pull") return <ArrowDownGlyph />;
  if (action === "sync") return <SyncGlyph />;
  return <ArrowUpGlyph />;
}

function CheckGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 8.5l3 3 7-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowUpGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 13V3M3.5 7.5L8 3l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowDownGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 3v10M3.5 8.5L8 13l4.5-4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SyncGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 8a6 6 0 0 1 10.2-4.2M14 8a6 6 0 0 1-10.2 4.2M14 2v4h-4M2 14v-4h4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RefreshGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path
        d="M14 8a6 6 0 1 1-1.7-4.2M14 2v4h-4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDownGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BranchGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="shrink-0 text-text-3">
      <circle cx="4" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="13" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 4.5v7M4 8c0-2 2-3.5 4-3.5h2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
