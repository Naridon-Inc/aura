// ChangesView — the references-grade "Changes" surface for a Trace session.
//
// Replaces the old flat list of expand-in-place file rows with the two-pane
// shape the reference diff tools use: a folder-grouped CHANGE TREE on the left
// (single-child directory chains collapsed into one row, per-file +/−, summed
// per folder) and a rendered DIFF on the right with a syntax-highlighted
// side-by-side (Monaco) ↔ unified (dependency-free) toggle.
//
// Responsive: a ResizeObserver collapses the two panes into one column when the
// surface is narrow — the tree shows first, picking a file slides to the diff
// with a back affordance (no CSS media queries, matching the app's JS-driven
// breakpoint precedent).
//
// HONESTY RULE (inherited from SessionDetailPane): the diff body is a real git
// diff and nothing else. A live/manual claim shows `git diff HEAD -- <path>`
// (the working tree). A back-filled run stamps each file with the commit that
// landed it, so we show that commit's real patch (`git show <sha> -- <path>`)
// — the run's actual change — instead of an empty working-tree diff. The
// tree's +/− come straight from the changeset row's recorded counts.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type FileChangeNote, type IntentChangesetFile } from "../../lib/api";
import { loadFileDiff } from "../../lib/sessionDataCache";
import { fetchChangeNoteReport } from "../../lib/changeNoteCache";
import { UnifiedDiff } from "../diff/UnifiedDiff";
import { SplitDiff, materializeSides } from "../diff/SplitDiff";
import { ChangeNoteCard } from "./ChangeNoteCard";
import { SplitDiffHeader } from "./SplitDiffHeader";
import {
  getDiffView,
  setDiffView,
  subscribeDiffView,
  type DiffView,
} from "../../lib/diffViewPref";
import {
  getIgnoreWhitespace,
  setIgnoreWhitespace,
  subscribeIgnoreWhitespace,
} from "../../lib/ignoreWhitespacePref";
import { isWorktreeRoot } from "../../lib/workspaceLabel";

// Monaco folds its side-by-side panes into one inline column below this pane
// width (matching `renderSideBySideInlineBreakpoint` on the DiffEditor). When
// that happens the two side-headers can't align to left/right, so they stack.
const SPLIT_INLINE_PX = 700;

// Below this surface width the two panes stack into one column.
const NARROW_PX = 560;

// ── status glyph ─────────────────────────────────────────────────────
// Matches SessionDetailPane's mapping. There is no text-accent-red utility,
// so deletions fall back to text-text-3 (the established decision).
function statusGlyph(status: string | undefined): {
  letter: "A" | "M" | "D" | "R";
  tone: string;
  word: string;
} {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "added" || s === "a" || s === "new") {
    return { letter: "A", tone: "text-accent-green", word: "added" };
  }
  if (s === "deleted" || s === "d" || s === "removed") {
    return { letter: "D", tone: "text-text-3", word: "deleted" };
  }
  if (s === "renamed" || s === "r") {
    return { letter: "R", tone: "text-text-2", word: "renamed" };
  }
  return { letter: "M", tone: "text-text-2", word: "modified" };
}

// ── tree model ───────────────────────────────────────────────────────

type FileLeaf = {
  kind: "file";
  name: string;
  path: string;
  status: string | undefined;
  adds: number;
  dels: number;
};

type FolderNode = {
  kind: "folder";
  name: string;
  /** Synthetic id (the folder's full slash-joined path) for collapse state. */
  path: string;
  children: TreeNode[];
  adds: number;
  dels: number;
  fileCount: number;
};

type TreeNode = FileLeaf | FolderNode;

/** Internal mutable folder used while building, before we freeze sums. */
type RawFolder = {
  name: string;
  path: string;
  folders: Map<string, RawFolder>;
  files: FileLeaf[];
};

/** Build a folder hierarchy from the flat changeset, then collapse any
 *  single-child directory chain into one row (so `a/b/c/file.ts` reads as a
 *  single `a/b/c` folder) and sum +/− bottom-up. */
function buildChangeTree(files: IntentChangesetFile[]): {
  nodes: TreeNode[];
  fileOrder: string[];
} {
  const root: RawFolder = {
    name: "",
    path: "",
    folders: new Map(),
    files: [],
  };

  for (const f of files) {
    const segs = f.path.split("/").filter(Boolean);
    const fileName = segs.length > 0 ? segs[segs.length - 1] : f.path;
    const dirs = segs.slice(0, -1);
    let cur = root;
    let acc = "";
    for (const d of dirs) {
      acc = acc ? `${acc}/${d}` : d;
      let next = cur.folders.get(d);
      if (!next) {
        next = { name: d, path: acc, folders: new Map(), files: [] };
        cur.folders.set(d, next);
      }
      cur = next;
    }
    cur.files.push({
      kind: "file",
      name: fileName,
      path: f.path,
      status: f.status,
      adds: typeof f.additions === "number" ? f.additions : 0,
      dels: typeof f.deletions === "number" ? f.deletions : 0,
    });
  }

  const fileOrder: string[] = [];

  function freeze(raw: RawFolder): TreeNode[] {
    const folderNodes: FolderNode[] = [];
    for (const sub of raw.folders.values()) {
      folderNodes.push(collapseFolder(sub));
    }
    folderNodes.sort((a, b) => a.name.localeCompare(b.name));
    const fileNodes = [...raw.files].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    // Record file render order (folders first, depth-first) for auto-select.
    const out: TreeNode[] = [...folderNodes, ...fileNodes];
    for (const n of out) {
      if (n.kind === "file") fileOrder.push(n.path);
    }
    return out;
  }

  function collapseFolder(raw: RawFolder): FolderNode {
    let name = raw.name;
    let path = raw.path;
    let work = raw;
    // Collapse while this folder holds exactly one child that is itself a
    // folder (and no files of its own) — the classic a/b/c chain.
    while (work.files.length === 0 && work.folders.size === 1) {
      const only = work.folders.values().next().value as RawFolder;
      name = `${name}/${only.name}`;
      path = only.path;
      work = only;
    }
    const children = freeze(work);
    let adds = 0;
    let dels = 0;
    let fileCount = 0;
    for (const c of children) {
      adds += c.adds;
      dels += c.dels;
      fileCount += c.kind === "file" ? 1 : c.fileCount;
    }
    return { kind: "folder", name, path, children, adds, dels, fileCount };
  }

  // freeze() pushes file order as it goes; call on root last so order is the
  // natural top-down walk.
  const nodes = freeze(root);
  return { nodes, fileOrder };
}

/** Flatten the tree into render rows honoring collapse state. */
type Row =
  | { kind: "folder"; node: FolderNode; depth: number }
  | { kind: "file"; node: FileLeaf; depth: number };

function flatten(
  nodes: TreeNode[],
  collapsed: Set<string>,
  depth = 0,
  out: Row[] = [],
): Row[] {
  for (const n of nodes) {
    if (n.kind === "folder") {
      out.push({ kind: "folder", node: n, depth });
      if (!collapsed.has(n.path)) flatten(n.children, collapsed, depth + 1, out);
    } else {
      out.push({ kind: "file", node: n, depth });
    }
  }
  return out;
}

/** Signed churn fragment — "+12 −3" with only the non-zero halves shown. */
function Churn({ adds, dels }: { adds: number; dels: number }) {
  if (adds <= 0 && dels <= 0) return null;
  return (
    <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
      {adds > 0 ? <span className="text-accent-green">+{adds}</span> : null}
      {adds > 0 && dels > 0 ? <span className="text-text-5"> </span> : null}
      {dels > 0 ? <span className="text-text-3">−{dels}</span> : null}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
      aria-hidden="true"
    >
      <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      {open ? (
        <>
          <path
            d="M2 5.25V12.5a1 1 0 0 0 1 1h10.2a1 1 0 0 0 .96-.72l1.3-4.43A.6.6 0 0 0 14.88 7.5H4.5L3 8.7"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path
            d="M2 5.25V4a1 1 0 0 1 1-1h2.5L7 4.5h5.5a1 1 0 0 1 1 1V7.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <path
          d="M2 4.5v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V5.5a1 1 0 0 0-1-1H7L5.5 3H3a1 1 0 0 0-1 1.5z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function BackIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

// ── change tree (left pane) ──────────────────────────────────────────

function ChangeTree({
  files,
  fileOrder,
  nodes,
  selected,
  onSelect,
}: {
  files: IntentChangesetFile[];
  fileOrder: string[];
  nodes: TreeNode[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  // Default: everything expanded (empty collapsed set). Folder paths toggle.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rows = useMemo(() => flatten(nodes, collapsed), [nodes, collapsed]);

  const totals = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const f of files) {
      if (typeof f.additions === "number") adds += f.additions;
      if (typeof f.deletions === "number") dels += f.deletions;
    }
    return { adds, dels };
  }, [files]);

  const allCollapsed = collapsed.size > 0;
  const collapseAll = () => {
    if (allCollapsed) {
      setCollapsed(new Set());
      return;
    }
    const all = new Set<string>();
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        if (n.kind === "folder") {
          all.add(n.path);
          walk(n.children);
        }
      }
    };
    walk(nodes);
    setCollapsed(all);
  };

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line-soft px-3 py-2">
        <span className="text-[11px] uppercase tracking-wide text-text-4">
          {fileOrder.length} {fileOrder.length === 1 ? "file" : "files"}
          {totals.adds > 0 || totals.dels > 0 ? (
            <span className="ml-1.5 font-mono normal-case tracking-normal">
              {totals.adds > 0 ? (
                <span className="text-accent-green">+{totals.adds}</span>
              ) : null}
              {totals.adds > 0 && totals.dels > 0 ? " " : ""}
              {totals.dels > 0 ? (
                <span className="text-text-3">−{totals.dels}</span>
              ) : null}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={collapseAll}
          className="rounded px-1.5 py-0.5 text-[10.5px] text-text-4 hover:bg-bg-2 hover:text-text-2"
          title={allCollapsed ? "Expand all folders" : "Collapse all folders"}
        >
          {allCollapsed ? "Expand" : "Collapse"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {rows.map((r) => {
          const indent = 8 + r.depth * 12;
          if (r.kind === "folder") {
            const open = !collapsed.has(r.node.path);
            return (
              <button
                key={`d:${r.node.path}`}
                type="button"
                onClick={() => toggle(r.node.path)}
                className="flex w-full items-center gap-1.5 py-1 pr-2.5 text-left hover:bg-bg-2"
                style={{ paddingLeft: indent }}
                title={r.node.path}
              >
                <span className="text-text-4">
                  <Chevron open={open} />
                </span>
                <span className="text-text-3">
                  <FolderGlyph open={open} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-text-2">
                  {r.node.name}
                </span>
                <Churn adds={r.node.adds} dels={r.node.dels} />
              </button>
            );
          }
          const g = statusGlyph(r.node.status);
          const isSel = selected === r.node.path;
          return (
            <button
              key={`f:${r.node.path}`}
              type="button"
              onClick={() => onSelect(r.node.path)}
              className={
                "flex w-full items-center gap-1.5 py-1 pr-2.5 text-left " +
                (isSel ? "bg-bg-card" : "hover:bg-bg-2")
              }
              style={{ paddingLeft: indent + 16 }}
              title={r.node.path}
            >
              <span
                className={"w-3 shrink-0 text-center font-mono text-[10.5px] " + g.tone}
                title={g.word}
              >
                {g.letter}
              </span>
              <span
                className={
                  "min-w-0 flex-1 truncate text-[12px] " +
                  (isSel ? "font-medium text-text-1" : "text-text-2")
                }
              >
                {r.node.name}
              </span>
              <Churn adds={r.node.adds} dels={r.node.dels} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── diff pane (right pane) ───────────────────────────────────────────
// The split-diff renderer + `materializeSides` now live in the shared
// ../diff/SplitDiff module so the working-file pane uses the identical view.

function DiffPane({
  repoRoot,
  file,
  narrow,
  sinceBase,
  onBack,
  onBringBack,
  busySymbol,
}: {
  repoRoot: string;
  file: IntentChangesetFile;
  /** When narrow we render single-column with a back affordance. */
  narrow: boolean;
  /** "All changes" mode (worktrees): a working-tree file's diff spans the
   *  worktree's fork base → working tree (committed + uncommitted), not just
   *  vs HEAD. A committed-sha file always shows that commit's patch regardless. */
  sinceBase: boolean;
  onBack: () => void;
  /** When set, the split header offers per-piece "Bring this back" (surgical
   *  undo) right beside each changed symbol. */
  onBringBack?: (symbol: string, relFile: string) => void;
  busySymbol?: string | null;
}) {
  // The split/unified choice is the one shared, persisted preference (so it
  // matches the working-file pane and survives reloads). Read it on mount and
  // re-read whenever any pane flips the toggle.
  const [mode, setMode] = useState<DiffView>(getDiffView);
  useEffect(() => subscribeDiffView(setMode), []);
  // Whitespace-hiding is the same shared, persisted toggle across every pane.
  const [ignoreWs, setIgnoreWs] = useState(getIgnoreWhitespace);
  useEffect(() => subscribeIgnoreWhitespace(setIgnoreWs), []);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The per-file change-note for THIS file in THIS commit, used to populate the
  // split diff's three-block header (merged summary + previous/new side
  // columns). Same shared (repo, commit) cache the unified path's
  // ChangeNoteCard reads, so it costs no extra engine round-trip.
  const [note, setNote] = useState<FileChangeNote | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  // Track the diff body width: below SPLIT_INLINE_PX Monaco folds its split
  // into one inline column, so the side-headers must stack to stay honest.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyNarrow, setBodyNarrow] = useState(false);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setBodyNarrow(e.contentRect.width < SPLIT_INLINE_PX);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pull the change-note for the committed file so the split header has real
  // data. A live/manual change has no commit sha → no note (header is skipped).
  useEffect(() => {
    setNote(null);
    setReason(null);
    if (!repoRoot || !file.commit) return;
    let alive = true;
    fetchChangeNoteReport(repoRoot, file.commit)
      .then((report) => {
        if (!alive) return;
        setNote(report.files.find((f) => f.file === file.path) ?? null);
        const first = (report.commit_message ?? "")
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0);
        setReason(first ?? null);
      })
      .catch(() => {
        /* header stays hidden on a miss — the diff is still the star */
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, file.commit, file.path]);

  useEffect(() => {
    if (!repoRoot) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setDiff(null);
    // A back-filled changeset stamps each file with the commit that landed it;
    // once a run is committed `git diff HEAD` is empty, so we show that commit's
    // real patch (`git show <sha> -- <path>`). A live/manual claim has no commit
    // sha — its change is still in the working tree, so fall back to git diff.
    // Routed through the per-session diff cache so re-selecting a file (or
    // reopening the whole session) is instant instead of re-shelling git.
    loadFileDiff(repoRoot, file, sinceBase)
      .then((d) => {
        if (alive) setDiff(d ?? "");
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, file.path, file.commit, sinceBase]);

  const g = statusGlyph(file.status);
  const adds = typeof file.additions === "number" ? file.additions : 0;
  const dels = typeof file.deletions === "number" ? file.deletions : 0;
  const hasDiff = !!diff && diff.trim().length > 0;
  // Split needs two sides; a one-sided (new/deleted) file falls back to
  // unified so the toggle never lands on a visually-broken split.
  const sidesPreview = useMemo(
    () => (hasDiff ? materializeSides(diff as string) : null),
    [hasDiff, diff],
  );
  const splitDisabled = narrow || (sidesPreview?.oneSided ?? false);
  const effectiveMode: DiffView = splitDisabled ? "unified" : mode;
  // The change note scrolls with the patch only in the unified path, where a
  // real scroll container exists below; loading/error/empty/split keep it
  // pinned above (collapsed, so it's a single unobtrusive line).
  const noteRidesScroll =
    effectiveMode === "unified" && hasDiff && !loading && !error;
  // In the split path the three-block SplitDiffHeader takes over the note's job
  // (merged summary + previous/new side columns aligned to the panes), so the
  // pinned collapsed ChangeNoteCard must NOT also render above it.
  const splitHeaderShows =
    effectiveMode === "split" && hasDiff && !loading && !error && !!note;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-content">
      {/* file header strip */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-2.5 py-1.5">
        {narrow ? (
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-text-3 hover:bg-bg-2 hover:text-text-1"
          >
            <BackIcon />
            <span>Files</span>
          </button>
        ) : null}
        <span
          className={"w-3 shrink-0 text-center font-mono text-[10.5px] " + g.tone}
          title={g.word}
        >
          {g.letter}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-2"
          dir="rtl"
          title={file.path}
        >
          {file.path}
        </span>
        <Churn adds={adds} dels={dels} />
        {!splitDisabled ? (
          <span className="ml-1 inline-flex shrink-0 items-center overflow-hidden rounded border border-line-soft">
            <button
              type="button"
              onClick={() => setDiffView("split")}
              className={
                "h-5 px-1.5 text-[10.5px] " +
                (effectiveMode === "split"
                  ? "bg-bg-2 text-text-1"
                  : "text-text-3 hover:text-text-1")
              }
              title="Side-by-side diff"
            >
              Split
            </button>
            <span className="h-3 w-px bg-line-soft" />
            <button
              type="button"
              onClick={() => setDiffView("unified")}
              className={
                "h-5 px-1.5 text-[10.5px] " +
                (effectiveMode === "unified"
                  ? "bg-bg-2 text-text-1"
                  : "text-text-3 hover:text-text-1")
              }
              title="Unified (inline) diff"
            >
              Unified
            </button>
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setIgnoreWhitespace(!ignoreWs)}
          aria-pressed={ignoreWs}
          title={ignoreWs ? "Whitespace-only changes hidden" : "Hide whitespace-only changes"}
          className={
            "ml-1 h-5 shrink-0 rounded border px-1.5 text-[10.5px] " +
            (ignoreWs
              ? "border-[var(--color-accent)] bg-bg-2 text-[var(--color-accent)]"
              : "border-line-soft text-text-3 hover:text-text-1")
          }
        >
          WS
        </button>
      </div>

      {/* per-file change note — what / why / where it affects (committed files
          only; a working-tree change has no commit to derive the note from).
          For the unified patch the note rides INSIDE the scroll region below,
          so it scrolls away with the diff instead of pinning fixed height; the
          Monaco split owns its own viewport, so there the note stays pinned (it
          opens collapsed, a single line, so it costs almost nothing). */}
      {file.commit && !noteRidesScroll && !splitHeaderShows ? (
        <ChangeNoteCard repoRoot={repoRoot} commit={file.commit} path={file.path} />
      ) : null}

      {/* diff body */}
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="px-3 py-2 text-[11px] text-text-4">Loading diff…</div>
        ) : error ? (
          <div className="px-3 py-2 text-[11px] text-text-3">
            Couldn&rsquo;t load this diff.
            <span className="mt-1 block font-mono text-[10.5px] text-text-4">
              {error}
            </span>
          </div>
        ) : !hasDiff ? (
          <div className="px-3 py-2 text-[11px] text-text-4">
            {file.commit
              ? "This commit recorded no textual change for this file (mode-only or binary change)."
              : "No pending changes for this file — it matches the last commit (already committed or undone)."}
          </div>
        ) : effectiveMode === "split" ? (
          // Three-block header (merged summary + previous/new) above the Monaco
          // split, then the editor fills the remaining height. The header only
          // shows once the change-note is in; until then the split renders on
          // its own (the diff is the star, never blocked on the note).
          <div className="flex h-full min-h-0 flex-col">
            {splitHeaderShows && note ? (
              <SplitDiffHeader
                note={note}
                reason={reason}
                repoRoot={repoRoot}
                stacked={bodyNarrow}
                onBringBack={onBringBack}
                busySymbol={busySymbol}
              />
            ) : null}
            <div className="min-h-0 flex-1">
              <SplitDiff diff={diff as string} path={file.path} />
            </div>
          </div>
        ) : (
          <div className="h-full overflow-y-auto">
            {file.commit ? (
              <ChangeNoteCard
                repoRoot={repoRoot}
                commit={file.commit}
                path={file.path}
              />
            ) : null}
            <UnifiedDiff diff={diff as string} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── top-level two-pane container ─────────────────────────────────────

export function ChangesView({
  repoRoot,
  files,
  initialSelected,
  onBringBack,
  busySymbol,
}: {
  repoRoot: string;
  files: IntentChangesetFile[];
  /** Open straight to this file (e.g. a click from the Summary). The tab
   *  re-mounts ChangesView on entry, so seeding the initial selection is
   *  enough — no live sync needed. */
  initialSelected?: string | null;
  /** When set, each changed piece in the diff offers a surgical "Bring this
   *  back" (one-piece undo). Wired from a session's Changes tab so recovery
   *  lives where you see the change — the Time machine's job, folded in. */
  onBringBack?: (symbol: string, relFile: string) => void;
  busySymbol?: string | null;
}) {
  const { nodes, fileOrder } = useMemo(() => buildChangeTree(files), [files]);
  const [selected, setSelected] = useState<string | null>(
    initialSelected ?? null,
  );
  const [narrow, setNarrow] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // An agent worktree forked from a base, so "all the work done here" =
  // committed + uncommitted since that fork. The toggle lets the user narrow
  // back to just the uncommitted edits. Default "All changes" (true). The main
  // checkout has no fork base, so the toggle is hidden there and this stays the
  // harmless default (the Rust side falls back to vs-HEAD when no base exists).
  const isWorktree = isWorktreeRoot(repoRoot);
  const [sinceBase, setSinceBase] = useState(true);

  // ResizeObserver → narrow switch (no CSS media queries; matches the app's
  // JS breakpoint precedent).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setNarrow(e.contentRect.width < NARROW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wide layout auto-selects the first file so the diff pane is never blank.
  // Narrow layout intentionally starts on the list.
  useEffect(() => {
    if (narrow) return;
    if (selected && fileOrder.includes(selected)) return;
    if (fileOrder.length > 0) setSelected(fileOrder[0]);
  }, [narrow, selected, fileOrder]);

  const selectedFile = useMemo(
    () => files.find((f) => f.path === selected) ?? null,
    [files, selected],
  );

  const tree = (
    <ChangeTree
      files={files}
      fileOrder={fileOrder}
      nodes={nodes}
      selected={selected}
      onSelect={setSelected}
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Scope toggle — worktrees only. The main checkout has no fork base, so
          "All changes" would equal "Uncommitted only"; we hide it there to keep
          the chrome quiet. Plain words over git jargon (the audience is
          non-engineers). Active segment uses the arctic-blue accent. */}
      {isWorktree ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-2.5 py-1.5">
          <span className="text-[11px] text-text-3">Showing</span>
          <span className="inline-flex shrink-0 items-center overflow-hidden rounded border border-line-soft">
            <button
              type="button"
              onClick={() => setSinceBase(true)}
              className={
                "h-5 px-2 text-[10.5px] " +
                (sinceBase
                  ? "bg-accent/15 font-medium text-accent"
                  : "text-text-3 hover:text-text-1")
              }
              title="Everything this copy changed since it branched off — committed and not yet committed"
            >
              All changes
            </button>
            <span className="h-3 w-px bg-line-soft" />
            <button
              type="button"
              onClick={() => setSinceBase(false)}
              className={
                "h-5 px-2 text-[10.5px] " +
                (!sinceBase
                  ? "bg-accent/15 font-medium text-accent"
                  : "text-text-3 hover:text-text-1")
              }
              title="Only what hasn't been committed yet"
            >
              Uncommitted only
            </button>
          </span>
        </div>
      ) : null}
      <div ref={containerRef} className="flex min-h-0 w-full flex-1">
        {narrow ? (
          selectedFile ? (
            <div className="h-full min-h-0 w-full">
              <DiffPane
                repoRoot={repoRoot}
                file={selectedFile}
                narrow
                sinceBase={isWorktree && sinceBase}
                onBack={() => setSelected(null)}
                onBringBack={onBringBack}
                busySymbol={busySymbol}
              />
            </div>
          ) : (
            <div className="h-full min-h-0 w-full">{tree}</div>
          )
        ) : (
          <>
            <div className="h-full min-h-0 w-[248px] shrink-0 border-r border-line-soft">
              {tree}
            </div>
            {/* min-w-0 lets this flex child shrink below Monaco's content width;
                without it the editor can't relayout on shrink and overflows. */}
            <div className="h-full min-h-0 min-w-0 flex-1">
              {selectedFile ? (
                <DiffPane
                  repoRoot={repoRoot}
                  file={selectedFile}
                  narrow={false}
                  sinceBase={isWorktree && sinceBase}
                  onBack={() => setSelected(null)}
                  onBringBack={onBringBack}
                  busySymbol={busySymbol}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[12px] text-text-4">
                  Select a file to view its diff.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
