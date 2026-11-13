// ChangesView — the "Changes" surface for a Trace session.
//
// Two columns: the changed files in the shared file tree on the left (single-
// child directory chains folded into one row, each file with its +/−), and
// the file's change on the right — its plain-words meaning first, the code
// second. The pieces live in ../trace/changes/.
//
// Responsive: a ResizeObserver collapses the two columns into one when the
// surface is narrow — the list shows first, picking a file slides to its
// change with a way back (no CSS media queries, matching the app's JS-driven
// breakpoint precedent).
//
// HONESTY RULE (inherited from SessionDetailPane): the diff body is a real git
// diff and nothing else, and the list's +/− come straight from the changeset
// row's recorded counts. See useChangeDiff for which diff each file reads.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FileDiff as FileDiffIcon } from "lucide-react";
import { api, type IntentChangesetFile } from "../../lib/api";
import { isWorktreeRoot } from "../../lib/workspaceLabel";
import { EmptyState } from "../ui/state";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { ChangeDiffPane } from "../trace/changes/ChangeDiffPane";
import { ChangeFileList } from "../trace/changes/ChangeFileList";
import { buildChangeTree, type ChangeSort } from "../trace/changes/changeTree";
import "../trace/changes/changes.css";

export { CHANGE_SORTS, type ChangeSort } from "../trace/changes/changeTree";

// Below this surface width the two columns stack into one.
const NARROW_PX = 560;

const SCOPES: { value: "all" | "uncommitted"; label: string; title: string }[] = [
  {
    value: "all",
    label: "All changes",
    title: "Everything this copy changed since it branched off. Committed and not yet committed",
  },
  { value: "uncommitted", label: "Uncommitted only", title: "Only what hasn't been committed yet" },
];

export function ChangesView({
  repoRoot,
  files,
  initialSelected,
  onBringBack,
  busySymbol,
  renderReasons,
}: {
  repoRoot: string;
  files: IntentChangesetFile[];
  /** Open straight to this file (e.g. a click from the Summary). The tab
   *  re-mounts ChangesView on entry, so seeding the initial selection is
   *  enough — no live sync needed. */
  initialSelected?: string | null;
  /** When set, each changed piece offers a surgical "Bring this back"
   *  (one-piece undo), so recovery lives where you see the change. */
  onBringBack?: (symbol: string, relFile: string) => void;
  busySymbol?: string | null;
  /** Host-supplied "why did this file change" band, shown above the diff. */
  renderReasons?: (file: IntentChangesetFile) => ReactNode;
}) {
  const [sort, setSort] = useState<ChangeSort>("path");
  const { nodes, fileOrder, folderIds } = useMemo(
    () => buildChangeTree(files, sort),
    [files, sort],
  );
  // Both alternative orderings need something to order by. A working-tree
  // changeset has neither churn nor stamps, and a picker whose two other
  // options are alphabetical-by-another-name is worse than no picker.
  const sortable = useMemo(
    () =>
      files.some(
        (f) =>
          typeof f.additions === "number" ||
          typeof f.deletions === "number" ||
          Boolean(f.changed_at),
      ),
    [files],
  );
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null);
  const [narrow, setNarrow] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // An editable diff with unsaved edits: leaving it for another file would
  // drop them silently, so ask first. The pane reports its own dirty state; a
  // confirmed leave clears it so the next pane starts clean.
  const dirtyRef = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);
  const select = useCallback((path: string | null) => {
    if (path === selectedRef.current) return;
    if (
      dirtyRef.current &&
      !window.confirm("This diff has edits you haven't saved. Leave without saving them?")
    ) {
      return;
    }
    dirtyRef.current = false;
    setSelected(path);
  }, []);

  // An agent worktree forked from a base, so "all the work done here" =
  // committed + uncommitted since that fork; the toggle narrows back to just
  // the uncommitted edits. The main checkout has no fork base, so the toggle
  // is hidden there and this stays the harmless default.
  const isWorktree = isWorktreeRoot(repoRoot);
  const [sinceBase, setSinceBase] = useState(true);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setNarrow(e.contentRect.width < NARROW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wide layout auto-selects the first file so the diff side is never blank.
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

  // Start writing the plain-language account of EVERY commit in this changeset
  // the moment the tab opens, in parallel — so the words for a file you haven't
  // reached yet are being written while you read the one you're on.
  // Fire-and-forget: the jobs land in the shared cache, and the surfaces that
  // read it (this file's header, later the same change in a pull request)
  // simply find it warm.
  const commits = useMemo(() => {
    const seen = new Set<string>();
    for (const f of files) if (f.commit) seen.add(f.commit);
    return [...seen];
  }, [files]);
  useEffect(() => {
    if (!repoRoot) return;
    for (const sha of commits) {
      void api.prewarmChangeSummaries(repoRoot, sha).catch(() => {});
    }
  }, [repoRoot, commits]);

  const list = (
    <ChangeFileList
      files={files}
      nodes={nodes}
      fileOrder={fileOrder}
      folderIds={folderIds}
      selected={selected}
      onSelect={select}
      sort={sort}
      onSort={setSort}
      sortable={sortable}
    />
  );
  const pane = (file: IntentChangesetFile) => (
    <ChangeDiffPane
      repoRoot={repoRoot}
      file={file}
      narrow={narrow}
      sinceBase={isWorktree && sinceBase}
      onBack={() => select(null)}
      onBringBack={onBringBack}
      busySymbol={busySymbol}
      renderReasons={renderReasons}
      onDirtyChange={onDirtyChange}
    />
  );

  return (
    <div className="ui-changes-view">
      {/* Worktrees only: the main checkout has no fork base, so "All changes"
          would equal "Uncommitted only". Plain words over git jargon. */}
      {isWorktree ? (
        <div className="ui-changes-scope">
          <span>Showing</span>
          <ToggleGroup
            type="single"
            size="sm"
            aria-label="Which changes to show"
            value={sinceBase ? "all" : "uncommitted"}
            onValueChange={(v) => v && setSinceBase(v === "all")}
          >
            {SCOPES.map((o) => (
              <ToggleGroupItem key={o.value} value={o.value} title={o.title}>
                {o.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      ) : null}
      <div ref={containerRef} className="ui-changes">
        {narrow ? (
          selectedFile ? (
            pane(selectedFile)
          ) : (
            list
          )
        ) : (
          <>
            <div className="ui-changes-list">{list}</div>
            {/* min-width 0 lets this column shrink below the editor's content
                width; without it the editor can't relayout on shrink. */}
            <div className="ui-changes-main">
              {selectedFile ? (
                pane(selectedFile)
              ) : (
                <EmptyState
                  icon={FileDiffIcon}
                  title="Select a file to view its diff."
                  size="sm"
                  className="ui-changes-empty"
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
