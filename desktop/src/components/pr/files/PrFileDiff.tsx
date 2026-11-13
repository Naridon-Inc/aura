// One file's patch in the Files tab, with its review threads pinned beside
// the lines they talk about.

import { useCallback, useMemo } from "react";
import type { PrComment } from "../../../lib/api";
import { PrDiffBody } from "../PrDiffBody";
import { groupThreads } from "../thread/prThreads";
import { usePrThreadRegister } from "../PrThreadColumn";

// Split a unified-diff body into a map { path -> hunk text }. Each
// `diff --git a/X b/Y` boundary starts a new chunk; we use the b-side
// path as the key (matches `gh pr view --json files`).
export function splitDiffByFile(body: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!body) return out;
  const re = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  type Hit = { idx: number; path: string };
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    hits.push({ idx: m.index, path: m[2] });
  }
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].idx;
    const end = i + 1 < hits.length ? hits[i + 1].idx : body.length;
    out.set(hits[i].path, body.slice(start, end));
  }
  return out;
}

// FluidDiff bridges PrDiffBody's (rightLine, el) anchor callback to
// PrThreadProvider's register(key, el, thread) API, so threads for the
// active file render as floating popout cards in the right column
// (PrThreadColumn) instead of a flat list in a side rail.
export function PrFileDiff({
  repoRoot,
  prNumber,
  filePath,
  body,
  comments,
  onPosted,
}: {
  repoRoot: string;
  prNumber: number;
  filePath: string;
  body: string;
  comments: PrComment[];
  onPosted: () => void;
}) {
  const register = usePrThreadRegister();
  const threadByLine = useMemo(() => {
    const m = new Map<number, ReturnType<typeof groupThreads>[number]>();
    const own = comments.filter(
      (c) => !c.is_issue_comment && c.path === filePath,
    );
    for (const t of groupThreads(own)) {
      if (t.root.line != null) m.set(t.root.line, t);
    }
    return m;
  }, [comments, filePath]);
  const registerRow = useCallback(
    (rightLine: number, el: HTMLElement | null) => {
      if (!register) return;
      const key = `${filePath}@${rightLine}`;
      const t = threadByLine.get(rightLine) ?? null;
      register(key, el, t);
    },
    [register, threadByLine, filePath],
  );
  return (
    <PrDiffBody
      repoRoot={repoRoot}
      prNumber={prNumber}
      filePath={filePath}
      body={body}
      comments={comments}
      onPosted={onPosted}
      onRegisterRow={registerRow}
    />
  );
}
