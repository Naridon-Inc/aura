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
// The dialog stays light: file list per pane + click-to-expand unified
// diff per file. For a richer side-by-side editor we'd reach for
// CodeMirror's MergeView, but that's overkill for "scan two attempts
// before promoting one."

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { api } from "../../lib/api";
import type { BranchDiffFile, WorktreeEntry } from "../../lib/api";

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
      .catch(() => setWorktrees([]))
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
        <Button variant="ghost" size="xs" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-3 text-[11.5px]">
        <div className="flex items-center gap-2">
          <span className="text-text-3">Compare against</span>
          <Select
            value={baseRef}
            onChange={setBaseRef}
            options={baseOptions}
            aria-label="Compare against"
            className="w-auto min-w-[180px]"
          />
          <span className="text-text-4">
            pick up to {MAX_PANES} parallel copies ({selected.length}/{MAX_PANES})
          </span>
        </div>

        {busy ? (
          <div className="text-text-4 italic">loading parallel copies…</div>
        ) : candidates.length === 0 ? (
          <div className="text-text-4 italic">
            no other parallel copies on this project yet. Aura creates one
            per task; try running a task to populate them.
          </div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {candidates.map((w) => {
              const checked = selected.includes(w.branch);
              const disabled = !checked && selected.length >= MAX_PANES;
              return (
                <li
                  key={w.path}
                  onClick={() => !disabled && toggle(w.branch)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded border cursor-pointer ${
                    checked
                      ? "bg-bg-3 border-line"
                      : disabled
                        ? "bg-bg-1 border-line-soft opacity-50 cursor-not-allowed"
                        : "bg-bg-1 border-line-soft hover:bg-bg-2"
                  }`}
                  title={w.path}
                >
                  <span
                    className={`inline-block rounded-sm border ${
                      checked
                        ? "bg-violet border-violet"
                        : "border-line bg-transparent"
                    }`}
                    style={{ width: 11, height: 11 }}
                  />
                  <span className="font-mono text-text-1 truncate">
                    {w.branch}
                  </span>
                  <span className="text-text-4 font-mono text-[10px] ml-auto">
                    {w.head.slice(0, 7)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {selected.length >= 2 && (
          <div
            className="grid gap-3 mt-2"
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
          <pre className="bg-bg-1 border border-line-soft rounded px-2 py-1.5 text-[10.5px] text-text-2 whitespace-pre-wrap max-h-32 overflow-auto">
            {mergeMsg}
          </pre>
        )}
        {mergeErr && (
          <pre className="bg-red/10 border border-red/40 rounded px-2 py-1.5 text-[10.5px] text-red whitespace-pre-wrap max-h-32 overflow-auto">
            {mergeErr}
          </pre>
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
  const [diffText, setDiffText] = useState<string>("");

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
    <div className="bg-bg-1 border border-line-soft rounded flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-line-soft">
        <span className="font-mono text-text-1 truncate flex-1" title={headRef}>
          {headRef}
        </span>
        <span className="text-accent-green font-mono text-[10px]">
          +{totals.add}
        </span>
        <span className="text-red font-mono text-[10px]">−{totals.del}</span>
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: 300 }}>
        {loading ? (
          <div className="px-2 py-2 text-text-4 italic">loading…</div>
        ) : files.length === 0 ? (
          <div className="px-2 py-2 text-text-4 italic">no changes</div>
        ) : (
          <ul>
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() =>
                    setOpenFile((cur) => (cur === f.path ? null : f.path))
                  }
                  className={`w-full text-left flex items-center gap-2 px-2 py-1 font-mono text-[10.5px] hover:bg-bg-2 ${
                    openFile === f.path ? "bg-bg-3" : ""
                  }`}
                >
                  <span
                    className="inline-block w-3 text-center text-text-4"
                    title={statusName(f.status)}
                  >
                    {f.status[0]}
                  </span>
                  <span className="truncate flex-1 text-text-1">{f.path}</span>
                  <span className="text-accent-green">+{f.additions}</span>
                  <span className="text-red">−{f.deletions}</span>
                </button>
                {openFile === f.path && (
                  <pre className="bg-bg-0 border-y border-line-soft px-2 py-1.5 text-[10px] font-mono whitespace-pre overflow-x-auto max-h-64 leading-snug">
                    {colorizeDiff(diffText)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-line-soft p-1.5">
        <Button
          variant="default"
          size="xs"
          onClick={onPromote}
          disabled={merging || files.length === 0}
          className="w-full"
        >
          {merging ? "keeping…" : "Keep this copy"}
        </Button>
      </div>
    </div>
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

// Minimal +/-/@@ syntax tinting on the unified diff. Real syntax
// highlighting would need a proper parser; this is enough for a
// dialog meant for triage.
function colorizeDiff(text: string): React.ReactNode {
  if (!text) return "no diff";
  const lines = text.split("\n");
  return lines.map((line, i) => {
    let cls = "text-text-2";
    if (line.startsWith("+++") || line.startsWith("---"))
      cls = "text-text-3 font-semibold";
    else if (line.startsWith("@@")) cls = "text-violet";
    else if (line.startsWith("+")) cls = "text-accent-green";
    else if (line.startsWith("-")) cls = "text-red";
    return (
      <div key={i} className={cls}>
        {line || " "}
      </div>
    );
  });
}
