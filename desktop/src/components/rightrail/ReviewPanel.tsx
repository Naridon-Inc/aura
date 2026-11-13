// The Review tab: every changed file with a box to tick once you've read it,
// and a running "n of N files reviewed". Clicking a name opens its diff.

import { useEffect, useMemo, useState } from "react";

import { isNoisePath } from "@shared/categorizeChange";
import { useGitChanges, type ChangedFile } from "../../lib/useGitChanges";
import { DetailsCaption, DetailsReviewRow } from "../ui/details-panel";
import { ErrorState, LoadingState } from "../ui/state";
import { displayNames } from "./changeNodes";
import { matchesRailFilter, useRailFilter } from "./railFilter";
import { liveMarks, loadReviewed, saveReviewed, stampOf } from "./reviewedFiles";

type Props = {
  repoRoot: string;
  onOpenFile?: (path: string, mode: "diff" | "diff-new-tab" | "edit") => void;
};

/** One row per path: a file staged and then edited again is one file to read. */
function reviewable(staged: ChangedFile[], unstaged: ChangedFile[], untracked: ChangedFile[]) {
  const seen = new Map<string, ChangedFile>();
  for (const f of [...unstaged, ...untracked, ...staged]) {
    if (isNoisePath(f.path) || seen.has(f.path)) continue;
    seen.set(f.path, f);
  }
  return [...seen.values()];
}

export function ReviewPanel({ repoRoot, onOpenFile }: Props) {
  const changes = useGitChanges(repoRoot);
  const filter = useRailFilter();
  const [marks, setMarks] = useState<Record<string, string>>(() => loadReviewed(repoRoot));

  useEffect(() => setMarks(loadReviewed(repoRoot)), [repoRoot]);

  const files = useMemo(
    () => reviewable(changes.staged, changes.unstaged, changes.untracked),
    [changes.staged, changes.unstaged, changes.untracked],
  );
  const stamped = useMemo(
    () => files.map((f) => ({ file: f, path: f.path, stamp: stampOf(f) })),
    [files],
  );
  const held = useMemo(() => liveMarks(marks, stamped), [marks, stamped]);
  const names = useMemo(() => displayNames(files.map((f) => f.path)), [files]);

  // Drop marks that no longer hold once git has answered, so storage only
  // ever carries reviews of the change on disk.
  useEffect(() => {
    if (changes.loading || changes.error) return;
    if (Object.keys(held).length !== Object.keys(marks).length) saveReviewed(repoRoot, held);
  }, [held, marks, repoRoot, changes.loading, changes.error]);

  const mark = (path: string, stamp: string, reviewed: boolean) => {
    const next = { ...held };
    if (reviewed) next[path] = stamp;
    else delete next[path];
    setMarks(next);
    saveReviewed(repoRoot, next);
  };

  if (files.length === 0) {
    if (changes.error) {
      return (
        <div className="px-3 py-5">
          <ErrorState
            size="sm"
            title="Aura couldn’t read your changes"
            message="Aura couldn’t ask git what you’ve changed. Nothing has been lost. It keeps trying every few seconds."
          />
        </div>
      );
    }
    if (changes.loading) return <LoadingState label="Looking at what you’ve changed…" />;
    return <DetailsCaption>No changes to review</DetailsCaption>;
  }

  const shown = stamped.filter(({ path }) => matchesRailFilter(path, filter));
  return (
    <>
      <DetailsCaption>
        {Object.keys(held).length} of {files.length} files reviewed
      </DetailsCaption>
      {shown.map(({ file, path, stamp }) => (
        <DetailsReviewRow
          key={path}
          name={names.get(path) ?? path}
          title={path}
          added={file.additions}
          removed={file.deletions}
          reviewed={held[path] === stamp}
          onReviewedChange={(reviewed) => mark(path, stamp, reviewed)}
          onOpen={() => onOpenFile?.(path, "diff")}
        />
      ))}
      {shown.length === 0 && <DetailsCaption>No changed file matches that filter</DetailsCaption>}
    </>
  );
}
