// CommitFiles — the "Files changed" list for one saved version (commit) in the
// History detail. A plain git log shows a wall of diff; here we lead with the
// human read: which files this version touched, what happened to each (added /
// edited / removed / renamed), and how much moved. Click a file to read its
// real committed diff below. Data is real — one `git show --numstat
// --name-status` per commit, no guesses.

import { useEffect, useState } from "react";
import { FileText } from "lucide-react";

import { api, type GitCommitFileStat } from "../../../lib/api";

// Plain-language word + tone for a single-letter git status. Deletions fall
// back to text-text-3 (there's no red text utility, the established decision).
function statusMeta(status: string): { word: string; tone: string; letter: string } {
  const s = status.trim().toUpperCase();
  if (s.startsWith("A")) return { word: "added", tone: "text-accent-green", letter: "A" };
  if (s.startsWith("D")) return { word: "removed", tone: "text-text-3", letter: "D" };
  if (s.startsWith("R")) return { word: "renamed", tone: "text-text-2", letter: "R" };
  if (s.startsWith("C")) return { word: "copied", tone: "text-text-2", letter: "C" };
  return { word: "edited", tone: "text-text-2", letter: "M" };
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

export function CommitFiles({
  repoRoot,
  sha,
  selected,
  onSelect,
}: {
  repoRoot: string;
  sha: string;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [files, setFiles] = useState<GitCommitFileStat[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let alive = true;
    setState("loading");
    setFiles([]);
    api
      .gitCommitFileStats(repoRoot, sha)
      .then((rows) => {
        if (!alive) return;
        setFiles(rows);
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, sha]);

  if (state === "loading") {
    return <div className="px-1 py-2 text-[12px] text-text-4">Reading the files…</div>;
  }
  if (state === "error") {
    return (
      <div className="px-1 py-2 text-[12px] text-text-4">
        Couldn’t read the files for this version.
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div className="px-1 py-2 text-[12px] text-text-4">
        This version recorded no file changes (it may be a merge or an empty
        commit).
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {files.map((f) => {
        const meta = statusMeta(f.status);
        const isSel = selected === f.path;
        const name = baseName(f.path);
        const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, "");
        const binary = f.added < 0 || f.deleted < 0;
        return (
          <button
            key={f.path}
            type="button"
            onClick={() => onSelect(f.path)}
            title={f.path}
            className={
              "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors " +
              (isSel ? "bg-bg-card" : "hover:bg-bg-2")
            }
          >
            <FileText size={13} className="shrink-0 text-text-4" />
            <span
              className={"w-3 shrink-0 text-center font-mono text-[10px] " + meta.tone}
              title={meta.word}
            >
              {meta.letter}
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span
                className={
                  "truncate text-[12.5px] " +
                  (isSel ? "font-medium text-text-1" : "text-text-1")
                }
              >
                {name}
              </span>
              {dir && (
                <span className="truncate text-[10px] text-text-4">{dir}</span>
              )}
            </span>
            {binary ? (
              <span className="shrink-0 text-[10px] text-text-4">binary</span>
            ) : (
              (f.added > 0 || f.deleted > 0) && (
                <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
                  {f.added > 0 && <span className="text-accent-green">+{f.added}</span>}
                  {f.added > 0 && f.deleted > 0 && <span className="text-text-5"> </span>}
                  {f.deleted > 0 && <span className="text-text-3">−{f.deleted}</span>}
                </span>
              )
            )}
          </button>
        );
      })}
    </div>
  );
}
