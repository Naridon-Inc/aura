// Source Control Changes panel — Superset-style three-section layout:
// staged / unstaged / untracked, each collapsible with a count chip and
// hover-only "stage all / unstage all" actions. Per-row controls live
// in FileRow. Mounted in the Source Control sidebar; Comms owns the
// right rail so git review is not duplicated.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { useGitChanges, type ChangedFile } from "../../lib/useGitChanges";
import { isNoisePath } from "../../lib/categorizeChange";
import { AURA_SYNC_ENABLED, AURA_RADAR_ENABLED } from "../../lib/featureFlags";
import { CategorySection } from "./CategorySection";
import { CommitInput } from "./CommitInput";
import { FileRow } from "./FileRow";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { useLiveSync } from "./sync/useLiveSync";
import { GoLiveControl } from "./sync/GoLiveControl";
import { IncomingSection } from "./sync/IncomingSection";
import { ConflictsSection } from "./sync/ConflictsSection";
import { TeamRadarSection } from "./radar/TeamRadarSection";

const SECTIONS_OPEN_KEY = "aura.rightRail.sections";

// "generated" is the clubbed bucket of machine churn (.aura/** snapshots,
// build output, editor cruft) — collapsed by default so it stays out of
// the way while the real edits sit expanded above it.
type SectionKey = "staged" | "unstaged" | "untracked" | "generated";
type SectionsOpen = Record<SectionKey, boolean>;

const DEFAULT_OPEN: SectionsOpen = {
  staged: true,
  unstaged: true,
  untracked: true,
  generated: false,
};

function loadSectionsOpen(): SectionsOpen {
  try {
    const raw = localStorage.getItem(SECTIONS_OPEN_KEY);
    if (!raw) return DEFAULT_OPEN;
    return { ...DEFAULT_OPEN, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_OPEN;
  }
}

type OpenMode = "diff" | "diff-new-tab" | "edit";

type Props = {
  repoRoot: string;
  /** Click on a row → open the file in the work surface. The mode is
   *  derived from the MouseEvent modifiers: plain click → "diff",
   *  Shift → "diff-new-tab", Cmd/Ctrl → "edit". App.tsx routes each
   *  mode through the existing editor open path. */
  onOpenFile?: (path: string, mode: OpenMode) => void;
  /** Optional strict-mode gate before commit actions. */
  onBeforeCommit?: () => Promise<boolean>;
};

function openModeFor(e: React.MouseEvent): OpenMode {
  if (e.shiftKey) return "diff-new-tab";
  if (e.metaKey || e.ctrlKey) return "edit";
  return "diff";
}

export function ChangesPanel({ repoRoot, onOpenFile, onBeforeCommit }: Props) {
  const changes = useGitChanges(repoRoot);
  const [open, setOpen] = useState<SectionsOpen>(loadSectionsOpen);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after any mutation so CommitInput re-polls ahead/behind.
  const [refreshTick, setRefreshTick] = useState(0);

  // Live sync layer (folded into this panel, gated by AURA_SYNC_ENABLED).
  // When off the hook no-ops and never polls.
  const sync = useLiveSync(repoRoot, AURA_SYNC_ENABLED);
  const [liveOpen, setLiveOpen] = useState({ incoming: true, conflicts: true });
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const openLiveFile = useCallback(
    (path: string) => {
      setSelected(path);
      onOpenFile?.(path, "diff");
    },
    [onOpenFile],
  );

  const resolveConflict = useCallback(
    async (id: string, strategy: "ours" | "theirs") => {
      setResolvingId(id);
      try {
        await api.auraConflictsResolve(repoRoot, {
          conflict_id: id,
          strategy,
        });
        await sync.refresh();
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setResolvingId(null);
      }
    },
    [repoRoot, sync.refresh],
  );

  const liveActive = AURA_SYNC_ENABLED && sync.live;

  // Split each git-state bucket into the files the user cares about
  // (signal — real edits) and machine churn (noise — .aura/** snapshots,
  // build output, editor cruft). Noise is clubbed into one collapsed
  // "Generated & ignored" group so it stops drowning the real changes.
  const parts = useMemo(() => {
    const sigStaged = changes.staged.filter((f) => !isNoisePath(f.path));
    const sigUnstaged = changes.unstaged.filter((f) => !isNoisePath(f.path));
    const sigUntracked = changes.untracked.filter((f) => !isNoisePath(f.path));
    // Carry each noise file's git-state so its row keeps the right
    // stage/unstage/discard affordances even inside the merged group.
    const noise: { file: ChangedFile; mode: SectionKey }[] = [];
    const seen = new Set<string>();
    const collect = (list: ChangedFile[], mode: SectionKey) => {
      for (const f of list) {
        if (!isNoisePath(f.path)) continue;
        const key = `${mode}:${f.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        noise.push({ file: f, mode });
      }
    };
    collect(changes.staged, "staged");
    collect(changes.unstaged, "unstaged");
    collect(changes.untracked, "untracked");
    const signalPaths = new Set<string>();
    for (const f of [...sigStaged, ...sigUnstaged, ...sigUntracked]) {
      signalPaths.add(f.path);
    }
    const noisePaths = new Set(noise.map((n) => n.file.path));
    return {
      sigStaged,
      sigUnstaged,
      sigUntracked,
      noise,
      signalCount: signalPaths.size,
      noiseCount: noisePaths.size,
    };
  }, [changes.staged, changes.unstaged, changes.untracked]);

  useEffect(() => {
    localStorage.setItem(SECTIONS_OPEN_KEY, JSON.stringify(open));
  }, [open]);

  // Footer diff badge → focus this panel + open the first changed file
  // in a diff workpane. We synthesise a plain (no-modifier) MouseEvent
  // so the existing `onOpenFile(path, "diff")` path runs unchanged.
  useEffect(() => {
    function onFocus() {
      // Prefer a real edit over machine churn when auto-opening.
      const first =
        parts.sigUnstaged[0] ??
        parts.sigStaged[0] ??
        parts.sigUntracked[0] ??
        changes.unstaged[0] ??
        changes.staged[0] ??
        changes.untracked[0];
      if (!first) return;
      setSelected(first.path);
      onOpenFile?.(first.path, "diff");
    }
    window.addEventListener("aura:focus-changes", onFocus);
    return () => window.removeEventListener("aura:focus-changes", onFocus);
  }, [parts, changes.unstaged, changes.staged, changes.untracked, onOpenFile]);

  const refreshAll = useCallback(async () => {
    await changes.refresh();
    setRefreshTick((t) => t + 1);
  }, [changes]);

  // A checkout (or commit) elsewhere in the git UI changes the working tree —
  // re-read so this panel never shows stale staged/unstaged files.
  useEffect(() => {
    const onGitChanged = () => void refreshAll();
    window.addEventListener("aura:git-changed", onGitChanged);
    return () => window.removeEventListener("aura:git-changed", onGitChanged);
  }, [refreshAll]);

  function toggle(key: SectionKey) {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const stagePaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setBusyPath(paths.join(","));
      try {
        await api.gitStage(repoRoot, paths);
        await refreshAll();
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyPath(null);
      }
    },
    [repoRoot, refreshAll],
  );

  const unstagePaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setBusyPath(paths.join(","));
      try {
        await api.gitUnstage(repoRoot, paths);
        await refreshAll();
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyPath(null);
      }
    },
    [repoRoot, refreshAll],
  );

  const discardPath = useCallback(
    async (path: string) => {
      setBusyPath(path);
      try {
        await api.gitDiscard(repoRoot, [path]);
        await refreshAll();
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyPath(null);
      }
    },
    [repoRoot, refreshAll],
  );

  function rowProps(file: ChangedFile, mode: SectionKey) {
    return {
      file,
      isSelected: selected === file.path,
      onClick: (e: React.MouseEvent) => {
        setSelected(file.path);
        onOpenFile?.(file.path, openModeFor(e));
      },
      onStage: mode !== "staged" ? () => stagePaths([file.path]) : undefined,
      onUnstage: mode === "staged" ? () => unstagePaths([file.path]) : undefined,
      onDiscard:
        mode !== "staged" ? () => discardPath(file.path) : undefined,
      isBusy: busyPath === file.path,
      repoRoot,
    };
  }

  const totalChanged = changes.changedCount + changes.untracked.length;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="flex items-center gap-2 h-8 px-3 border-b border-line-soft shrink-0 bg-bg-1/40 min-w-0">
        <span className="text-text-2 text-[11.5px] font-medium uppercase tracking-wider truncate shrink-0">
          Source Control
        </span>
        <span className="text-text-4 text-[10.5px] tabular-nums truncate min-w-0 flex-1">
          {totalChanged === 0
            ? "no changes"
            : parts.noiseCount > 0
              ? `${parts.signalCount} changed · ${parts.noiseCount} generated`
              : `${parts.signalCount} changed`}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("aura:open-branch-graph"))
                }
                className="size-5 rounded flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-bg-2 transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <circle cx="4" cy="3.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="4" cy="12.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="11.5" cy="8" r="1.7" stroke="currentColor" strokeWidth="1.3" />
                  <path
                    d="M4 5.2v5.6M4 8h3a2 2 0 0 1 2-1.8"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    fill="none"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Branch graph</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => changes.refresh()}
                className="size-5 rounded flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-bg-2 transition-colors"
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M14 8a6 6 0 1 1-1.7-4.2M14 2v4h-4"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Refresh</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {AURA_SYNC_ENABLED && (
        <GoLiveControl
          live={sync.live}
          busy={sync.busy}
          startedAt={sync.startedAt}
          peers={sync.peers}
          presenceHint={sync.presenceHint}
          onToggle={(next) => void (next ? sync.goLive() : sync.stopLive())}
        />
      )}

      {(error || sync.error) && (
        <div className="bg-red/10 text-red text-[10.5px] px-3 py-1.5 border-b border-red/30">
          {error ?? sync.error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Team Radar (awareness plane) — quiet by construction: renders
            nothing unless there are collisions or recent team activity. */}
        <TeamRadarSection
          repoRoot={repoRoot}
          enabled={AURA_RADAR_ENABLED}
          onOpenFile={openLiveFile}
        />
        {liveActive && (
          <>
            {/* Inbound first — what's arriving sits over what you're sending.
                Both auto-hide when empty (CategorySection count === 0). */}
            <IncomingSection
              impacts={sync.incoming}
              isOpen={liveOpen.incoming}
              onToggle={() =>
                setLiveOpen((o) => ({ ...o, incoming: !o.incoming }))
              }
              onOpenFile={openLiveFile}
            />
            <ConflictsSection
              conflicts={sync.conflicts}
              isOpen={liveOpen.conflicts}
              onToggle={() =>
                setLiveOpen((o) => ({ ...o, conflicts: !o.conflicts }))
              }
              busyId={resolvingId}
              onResolve={resolveConflict}
              onOpenFile={openLiveFile}
            />
          </>
        )}
        {changes.loading && totalChanged === 0 ? (
          <div className="text-text-4 text-[11px] px-3 py-3">loading…</div>
        ) : totalChanged === 0 ? (
          <div className="text-text-4 text-[11px] px-3 py-6 text-center">
            {liveActive ? "Your changes are in sync" : "No changes yet — every file matches your last save"}
          </div>
        ) : (
          <>
            <CategorySection
              title="Staged"
              count={parts.sigStaged.length}
              isOpen={open.staged}
              onToggle={() => toggle("staged")}
              actions={
                parts.sigStaged.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() =>
                          unstagePaths(parts.sigStaged.map((f) => f.path))
                        }
                        className="size-5 rounded flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-bg-1"
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                          <path
                            d="M3 8h10"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Unstage all</TooltipContent>
                  </Tooltip>
                ) : null
              }
            >
              {parts.sigStaged.map((f) => (
                <FileRow key={`s-${f.path}`} {...rowProps(f, "staged")} />
              ))}
            </CategorySection>

            <CategorySection
              title="Modified"
              count={parts.sigUnstaged.length}
              isOpen={open.unstaged}
              onToggle={() => toggle("unstaged")}
              actions={
                parts.sigUnstaged.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() =>
                          stagePaths(parts.sigUnstaged.map((f) => f.path))
                        }
                        className="size-5 rounded flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-bg-1"
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                          <path
                            d="M8 3v10M3 8h10"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Stage all</TooltipContent>
                  </Tooltip>
                ) : null
              }
            >
              {parts.sigUnstaged.map((f) => (
                <FileRow key={`u-${f.path}`} {...rowProps(f, "unstaged")} />
              ))}
            </CategorySection>

            <CategorySection
              title="New files"
              count={parts.sigUntracked.length}
              isOpen={open.untracked}
              onToggle={() => toggle("untracked")}
              actions={
                parts.sigUntracked.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() =>
                          stagePaths(parts.sigUntracked.map((f) => f.path))
                        }
                        className="size-5 rounded flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-bg-1"
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                          <path
                            d="M8 3v10M3 8h10"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Stage all</TooltipContent>
                  </Tooltip>
                ) : null
              }
            >
              {parts.sigUntracked.map((f) => (
                <FileRow key={`?-${f.path}`} {...rowProps(f, "untracked")} />
              ))}
            </CategorySection>

            {/* Machine churn clubbed together: .aura/** snapshots, build
                output, editor cruft. Collapsed by default, no "stage all"
                — staging these is deliberate, per-row only. */}
            <CategorySection
              title="Generated & ignored"
              count={parts.noiseCount}
              isOpen={open.generated}
              onToggle={() => toggle("generated")}
            >
              {parts.noise.map(({ file, mode }) => (
                <FileRow
                  key={`n-${mode}-${file.path}`}
                  {...rowProps(file, mode)}
                />
              ))}
            </CategorySection>
          </>
        )}
      </div>

      <CommitInput
        repoRoot={repoRoot}
        hasStagedChanges={changes.staged.length > 0}
        refreshTick={refreshTick}
        onBeforeCommit={onBeforeCommit}
        onAfterMutation={() => {
          void refreshAll();
        }}
        liveActive={liveActive}
      />
    </div>
  );
}
