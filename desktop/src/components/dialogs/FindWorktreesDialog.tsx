// Lost-worktree recovery — the manual way back when the sidebar loses
// checkouts. The roster's worktree rows come straight from `git worktree
// list`, so a crash that corrupts git's registry makes a checkout that
// still exists on disk simply vanish. This dialog scans the project's
// managed worktree folder for the disagreement and mends it:
//
//   • ORPHANS — a checkout on disk the project no longer lists. One
//     click attaches it back (git repair first, a rebuilt registration
//     when repair can't; working files are never touched).
//   • GHOSTS — the project lists it but the folder is gone. One click
//     clears the stale entries.
//
// Mirrors `worktree_recover.rs`. The caller refetches the roster's
// worktree list after anything changed (`onChanged`).

import { useCallback, useEffect, useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { api, type WorktreeScanReport } from "../../lib/api";

type FindWorktreesDialogProps = {
  open: boolean;
  repoRoot: string;
  /** The project's display name, for the intro line. */
  projectName: string;
  onClose: () => void;
  /** Something was attached or pruned — the roster should refetch. */
  onChanged: () => void;
};

/** Per-orphan action state, keyed by path. */
type RowState =
  | { kind: "busy" }
  | { kind: "done"; note: string }
  | { kind: "error"; message: string };

export function FindWorktreesDialog({
  open,
  repoRoot,
  projectName,
  onClose,
  onChanged,
}: FindWorktreesDialogProps) {
  const [report, setReport] = useState<WorktreeScanReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [pruning, setPruning] = useState(false);
  const [pruneNote, setPruneNote] = useState<string | null>(null);

  const scan = useCallback(() => {
    setScanning(true);
    setScanError(null);
    setReport(null);
    setRows({});
    setPruneNote(null);
    api
      .worktreeScanLost(repoRoot)
      .then(setReport)
      .catch((e) => setScanError(String(e)))
      .finally(() => setScanning(false));
  }, [repoRoot]);

  useEffect(() => {
    if (open) scan();
  }, [open, scan]);

  const attach = (path: string) => {
    setRows((prev) => ({ ...prev, [path]: { kind: "busy" } }));
    api
      .worktreeReattach(repoRoot, path)
      .then((out) => {
        setRows((prev) => ({
          ...prev,
          [path]: {
            kind: "done",
            note: out.branch ? `attached — ${out.branch}` : "attached",
          },
        }));
        onChanged();
      })
      .catch((e) => {
        setRows((prev) => ({
          ...prev,
          [path]: { kind: "error", message: String(e) },
        }));
      });
  };

  const prune = () => {
    setPruning(true);
    api
      .worktreePruneGhosts(repoRoot)
      .then((n) => {
        setPruneNote(
          n === 1 ? "1 stale entry cleared" : `${n} stale entries cleared`,
        );
        setReport((prev) => (prev ? { ...prev, ghosts: [] } : prev));
        onChanged();
      })
      .catch((e) => setPruneNote(String(e)))
      .finally(() => setPruning(false));
  };

  const orphans = report?.orphans ?? [];
  const ghosts = report?.ghosts ?? [];
  const clean = report !== null && orphans.length === 0 && ghosts.length === 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Find missing worktrees"
      width={560}
      footer={
        <>
          <Button variant="ghost" size="xs" onClick={scan} disabled={scanning}>
            Scan again
          </Button>
          <Button variant="default" size="xs" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {/* Flat rows, not bordered boxes — the house rule for lists in a card.
          Each finding is a divided row: name + quiet caption left, one action
          right. Body copy sits at the same size/tone every dialog body uses. */}
      <div className="space-y-3 text-sm">
        {scanning ? (
          <div className="flex items-center gap-2 py-2 text-text-3">
            <AsciiSpinner />
            Checking {projectName}'s worktree folder against git…
          </div>
        ) : scanError ? (
          <div role="alert" className="py-1 text-red">
            {scanError}
          </div>
        ) : clean ? (
          <div className="py-1 text-text-3">
            Everything lines up — every worktree on disk is attached to{" "}
            {projectName}, and nothing is listed that isn't there.
          </div>
        ) : (
          <>
            {orphans.length > 0 && (
              <div>
                <div className="section-label">
                  On disk, but missing from the sidebar
                </div>
                <div className="divide-y divide-line-soft">
                  {orphans.map((o) => {
                    const state = rows[o.path];
                    const name = o.path.split("/").pop() ?? o.path;
                    return (
                      <div
                        key={o.path}
                        className="flex items-center gap-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] text-text-1" title={o.path}>
                            {name}
                            {o.branch && (
                              <span className="ml-2 text-xs text-text-4">
                                {o.branch}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-text-4">
                            {state?.kind === "error" ? (
                              <span role="alert" className="text-red">
                                {state.message}
                              </span>
                            ) : state?.kind === "done" ? (
                              state.note
                            ) : (
                              o.reason
                            )}
                          </div>
                        </div>
                        {state?.kind === "done" ? (
                          <span className="shrink-0 text-xs text-accent">✓</span>
                        ) : (
                          <Button
                            variant="secondary"
                            size="xs"
                            className="shrink-0"
                            disabled={state?.kind === "busy" || !o.attachable}
                            title={
                              o.attachable
                                ? undefined
                                : "Can't tell which branch this belongs to — attach it by hand or remove the folder"
                            }
                            onClick={() => attach(o.path)}
                          >
                            {state?.kind === "busy" ? <AsciiSpinner /> : "Attach"}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {ghosts.length > 0 && (
              <div>
                <div className="section-label">
                  Listed, but the folder is gone
                </div>
                <div className="divide-y divide-line-soft">
                  {ghosts.map((g) => (
                    <div
                      key={g.path}
                      className="flex items-center gap-3 py-1.5"
                    >
                      <div
                        className="min-w-0 flex-1 truncate text-[13px] text-text-3"
                        title={g.path}
                      >
                        {g.path.split("/").pop() ?? g.path}
                        {g.branch && (
                          <span className="ml-2 text-xs text-text-5">
                            {g.branch}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={prune}
                    disabled={pruning}
                  >
                    {pruning ? <AsciiSpinner /> : "Clear stale entries"}
                  </Button>
                  {pruneNote && (
                    <span className="text-xs text-text-4">{pruneNote}</span>
                  )}
                </div>
              </div>
            )}
            {pruneNote && ghosts.length === 0 && (
              <div className="text-xs text-text-4">{pruneNote}</div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
