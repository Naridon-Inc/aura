// Compare-results 3-pane diff comparator for parallel agent runs.
// When the Manager dispatches the same task to multiple agents — or
// when a user spawns sibling worktrees by hand — each attempt produces
// a different branch off the same base. This dialog lets the user pick
// 2 (or 3) worktrees, see what each agent changed in side-by-side
// columns, and merge whichever looks best back into the base branch.
//
// The diff source is `git diff <base>...<head>` against the main repo
// (managed worktrees share .git so refs from any branch are visible),
// not the worktree's working tree — agents commit before completion,
// so what we want is "the work the branch committed since diverging."
//
// The dialog stays light: file list per pane + click-to-expand diff per
// file, drawn as the shared file diff. For a richer side-by-side editor we'd reach for
// CodeMirror's MergeView, but that's overkill for "scan two attempts
// before promoting one."

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "../Dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Select } from "../ui/select";
import { DiffCount } from "../ui/sidebar";
import { FileDiff } from "../ui/workspace-patterns";
import { api } from "../../lib/api";
import type { BranchDiffFile, WorktreeEntry } from "../../lib/api";
import { parseUnifiedDiff } from "../../lib/diff";
import "../ui/log-note.css";
import "../ui/compare-copies.css";

type Props = {
  open: boolean;
  /** Main repo root — anchors the diff base and the merge target. */
  repoRoot: string;
  onClose: () => void;
};

const MAX_PANES = 3;

export function CompareWorktreesDialog({ open, repoRoot, onClose }: Props) {
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [baseRef, setBaseRef] = useState<string>("HEAD");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [merging, setMerging] = useState<string | null>(null);
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);
  const [mergeErr, setMergeErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setBaseRef("HEAD");
    setMergeMsg(null);
    setMergeErr(null);
    setBusy(true);
    api
      .gitWorktreeList(repoRoot)
      .then((rows) => {
        setWorktrees(rows);
        // Default the base ref to the main worktree's branch when we
        // can resolve it — that's almost always what the user wants
        // ("compare these agent attempts against main").
        const main = rows.find((r) => r.is_main);
        if (main && main.branch) setBaseRef(main.branch);
      })
      // An empty list here would claim the project has no worktrees to
      // compare. It might have several — we just couldn't ask. Keep whatever
      // was last known and surface the reason instead of inventing "none".
      .catch((e) => setMergeErr(`Could not list worktrees: ${e}`))
      .finally(() => setBusy(false));
  }, [open, repoRoot]);

  function toggle(branch: string) {
    setSelected((prev) => {
      if (prev.includes(branch)) return prev.filter((b) => b !== branch);
      if (prev.length >= MAX_PANES) return prev;
      return [...prev, branch];
    });
  }

  const candidates = useMemo(
    () => worktrees.filter((w) => w.branch && w.branch !== baseRef),
    [worktrees, baseRef],
  );

  const baseOptions = useMemo(
    () => [
      { value: "HEAD", label: "Current commit" },
      ...worktrees
        .filter((w) => w.branch)
        .map((w) => ({
          value: w.branch,
          label: `${w.branch}${w.is_main ? " (main)" : ""}`,
        })),
    ],
    [worktrees],
  );

  async function promote(branch: string) {
    setMerging(branch);
    setMergeErr(null);
    setMergeMsg(null);
    try {
      const out = await api.gitMergeBranch(
        repoRoot,
        branch,
        `aura: promote agent attempt from ${branch}`,
      );
      setMergeMsg(out.trim() || `merged ${branch}`);
    } catch (e) {
      setMergeErr(String(e));
    } finally {
      setMerging(null);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Compare parallel copies"
      width={selected.length >= 2 ? 1100 : 640}
      footer={
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="ui-compare">
        <div className="ui-compare-base">
          <span>Compare against</span>
          <Select
            value={baseRef}
            onChange={setBaseRef}
            options={baseOptions}
            aria-label="Compare against"
          />
        </div>

        <section className="ui-log-note-files">
          <div className="ui-log-note-files-head">
            <span>Parallel copies</span>
            <span className="ui-log-note-count">
              {selected.length} of up to {MAX_PANES} picked
            </span>
          </div>
          {busy ? (
            <p className="ui-log-note-state" role="status">
              <AsciiSpinner />
              Looking for parallel copies…
            </p>
          ) : candidates.length === 0 ? (
            <p className="ui-pattern-empty ui-compare-empty">
              No other parallel copies of this repository yet. Aura makes one per
              task, so running a task fills this list.
            </p>
          ) : (
            <ul className="ui-log-note-list">
              {candidates.map((w) => {
                const checked = selected.includes(w.branch);
                const disabled = !checked && selected.length >= MAX_PANES;
                return (
                  <li key={w.path}>
                    <label
                      className="ui-check-label"
                      title={w.path}
                      data-unpicked={checked ? undefined : ""}
                      data-disabled={disabled ? "" : undefined}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={() => toggle(w.branch)}
                      />
                      <span className="ui-log-note-name ui-compare-branch">
                        {w.branch}
                      </span>
                      <span className="ui-log-note-dir">{w.head.slice(0, 7)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {selected.length < 2 && candidates.length > 0 && (
            <p className="ui-log-note-help">
              Pick two or three to see what each one changed side by side.
            </p>
          )}
        </section>

        {selected.length >= 2 && (
          <div
            className="ui-compare-panes"
            style={{
              gridTemplateColumns: `repeat(${selected.length}, minmax(0, 1fr))`,
            }}
          >
            {selected.map((branch) => (
              <ComparePane
                key={branch}
                repoRoot={repoRoot}
                baseRef={baseRef}
                headRef={branch}
                onPromote={() => promote(branch)}
                merging={merging === branch}
              />
            ))}
          </div>
        )}

        {mergeMsg && (
          <Alert className="ui-compare-result">
            <AlertDescription>
              <pre>{mergeMsg}</pre>
            </AlertDescription>
          </Alert>
        )}
        {mergeErr && (
          <Alert variant="destructive" className="ui-compare-result">
            <AlertDescription>
              <pre>{mergeErr}</pre>
            </AlertDescription>
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

function ComparePane({
  repoRoot,
  baseRef,
  headRef,
  onPromote,
  merging,
}: {
  repoRoot: string;
  baseRef: string;
  headRef: string;
  onPromote: () => void;
  merging: boolean;
}) {
  const [files, setFiles] = useState<BranchDiffFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  // null while the open file's diff is still being read.
  const [diffText, setDiffText] = useState<string | null>("");

  useEffect(() => {
    setLoading(true);
    setOpenFile(null);
    setDiffText("");
    api
      .gitBranchDiffFiles(repoRoot, baseRef, headRef)
      .then(setFiles)
      .catch(() => setFiles([]))
      .finally(() => setLoading(false));
  }, [repoRoot, baseRef, headRef]);

  useEffect(() => {
    if (!openFile) {
      setDiffText("");
      return;
    }
    let cancelled = false;
    setDiffText(null);
    api
      .gitBranchDiffFile(repoRoot, baseRef, headRef, openFile)
      .then((t) => {
        if (!cancelled) setDiffText(t);
      })
      .catch(() => {
        if (!cancelled) setDiffText("");
      });
    return () => {
      cancelled = true;
    };
  }, [openFile, repoRoot, baseRef, headRef]);

  const totals = files.reduce(
    (acc, f) => ({
      add: acc.add + f.additions,
      del: acc.del + f.deletions,
    }),
    { add: 0, del: 0 },
  );

  return (
    <section className="ui-compare-pane">
      <header>
        <strong title={headRef}>{headRef}</strong>
        <DiffCount added={totals.add} removed={totals.del} />
      </header>
      <div className="ui-compare-pane-body">
        {loading ? (
          <p className="ui-log-note-state" role="status">
            <AsciiSpinner />
            Comparing the two copies…
          </p>
        ) : files.length === 0 ? (
          <p className="ui-log-note-state">No changes</p>
        ) : (
          <ul className="ui-compare-files">
            {files.map((f) => {
              const expanded = openFile === f.path;
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    className="ui-compare-file"
                    aria-expanded={expanded}
                    onClick={() => setOpenFile((cur) => (cur === f.path ? null : f.path))}
                  >
                    <span className="ui-log-note-tag" title={statusName(f.status)}>
                      {f.status[0]}
                    </span>
                    <span className="ui-log-note-name">{f.path}</span>
                    <DiffCount added={f.additions} removed={f.deletions} />
                  </button>
                  {expanded &&
                    (diffText === null ? (
                      <p className="ui-log-note-state" role="status">
                        <AsciiSpinner />
                        Reading the change…
                      </p>
                    ) : diffText ? (
                      <FileDiff name={f.path} lines={parseUnifiedDiff(diffText)} />
                    ) : (
                      <p className="ui-log-note-state">No diff to show</p>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <footer>
        <Button
          size="sm"
          onClick={onPromote}
          disabled={merging || files.length === 0}
        >
          {merging ? "Keeping…" : "Keep this copy"}
        </Button>
      </footer>
    </section>
  );
}

function statusName(s: string): string {
  switch (s[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "T":
      return "type changed";
    default:
      return s;
  }
}
