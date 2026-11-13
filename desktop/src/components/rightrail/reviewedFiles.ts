// Which changed files the reader has marked reviewed, per project.
//
// A mark is pinned to the change it was made against — the file's status and
// line counts at the time — so a file that changes again after you ticked it
// comes back unticked instead of claiming a review it never had. Marks for
// files that are no longer changed are dropped on the next save.

export type ReviewStamp = { status: string; additions: number; deletions: number };

const KEY_PREFIX = "aura.rail.reviewed.v1:";

export function stampOf(f: ReviewStamp): string {
  return `${f.status}:${f.additions}:${f.deletions}`;
}

export function loadReviewed(repoRoot: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + repoRoot);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [path, stamp] of Object.entries(parsed)) {
      if (typeof stamp === "string") out[path] = stamp;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveReviewed(repoRoot: string, marks: Record<string, string>): void {
  try {
    if (Object.keys(marks).length === 0) localStorage.removeItem(KEY_PREFIX + repoRoot);
    else localStorage.setItem(KEY_PREFIX + repoRoot, JSON.stringify(marks));
  } catch {
    /* storage unavailable — the marks last for this session only */
  }
}

/** The marks that still hold: the file is still changed, and changed the same
 *  way it was when it was marked. */
export function liveMarks(
  marks: Record<string, string>,
  files: { path: string; stamp: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    if (marks[f.path] === f.stamp) out[f.path] = f.stamp;
  }
  return out;
}
