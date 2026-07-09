// CommittedFileDiff — the real diff for one file inside one saved version
// (commit), in the History detail. It pairs the per-file "why" card
// (ChangeNoteCard: what symbols moved, the recorded reason, the blast radius)
// with the actual committed diff for that file. The diff is exactly what git
// recorded for this commit — `git diff <sha>^..<sha> -- <file>` — not the
// working tree, so it stays truthful even long after the change landed.

import { useEffect, useState } from "react";

import { api } from "../../lib/api";
import { ChangeNoteCard } from "../workpanes/ChangeNoteCard";
import { UnifiedDiff } from "../diff/UnifiedDiff";

export function CommittedFileDiff({
  repoRoot,
  sha,
  path,
}: {
  repoRoot: string;
  sha: string;
  path: string;
}) {
  const [diff, setDiff] = useState<string>("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let alive = true;
    setState("loading");
    setDiff("");
    api
      .gitDiffAtCommit(repoRoot, sha, path)
      .then((text) => {
        if (!alive) return;
        setDiff(text);
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, sha, path]);

  return (
    <div className="overflow-hidden rounded-lg border border-line-soft bg-bg-content">
      {/* The per-file "why" — what moved, the reason, the ripple — sits above
          the diff it annotates, same as the Changes tab. It stays quiet when
          there's no recorded note for this file. */}
      <ChangeNoteCard repoRoot={repoRoot} commit={sha} path={path} />

      {state === "loading" ? (
        <div className="px-3 py-3 text-[12px] text-text-4">Reading the diff…</div>
      ) : state === "error" ? (
        <div className="px-3 py-3 text-[12px] text-text-4">
          Couldn’t read the diff for this file.
        </div>
      ) : diff.trim().length === 0 ? (
        <div className="px-3 py-3 text-[12px] text-text-4">
          No line changes recorded — this may be a rename, a mode change, or a
          binary file.
        </div>
      ) : (
        <UnifiedDiff diff={diff} />
      )}
    </div>
  );
}
