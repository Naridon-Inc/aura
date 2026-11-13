// The Changes tab's left column: how many files and lines the change holds,
// how the list is ordered, and the files themselves in the shared file tree
// (single-child folder chains already folded into one row).

import { useMemo, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import type { IntentChangesetFile } from "../../../lib/api";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { FileTree, type FileTreeNode } from "../../ui/file-tree";
import { DiffCount } from "../../ui/sidebar";
import { CHANGE_SORTS, fileChurn, folderSummary, type ChangeSort } from "./changeTree";

/** How the file list is ordered — the shared menu, so it reads the same here
 *  as every other dropdown in the app and in the browser console. */
function SortMenu({ sort, onSort }: { sort: ChangeSort; onSort: (s: ChangeSort) => void }) {
  const chosen = CHANGE_SORTS.find((o) => o.id === sort);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" aria-label="Order the file list" title={chosen?.hint}>
          {chosen?.label ?? "Name"}
          <ChevronsUpDown size={11} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={sort} onValueChange={(v) => onSort(v as ChangeSort)}>
          {CHANGE_SORTS.map((o) => (
            <DropdownMenuRadioItem key={o.id} value={o.id} title={o.hint}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ChangeFileList({
  files,
  nodes,
  fileOrder,
  folderIds,
  selected,
  onSelect,
  sort,
  onSort,
  sortable,
}: {
  files: IntentChangesetFile[];
  nodes: FileTreeNode[];
  fileOrder: string[];
  folderIds: string[];
  selected: string | null;
  onSelect: (path: string) => void;
  sort: ChangeSort;
  onSort: (s: ChangeSort) => void;
  /** False when nothing in the changeset carries churn or a stamp — offering
   *  an ordering the data cannot honour is a control that does nothing. */
  sortable: boolean;
}) {
  // Everything starts open; the reader closes folders. Kept as the closed set
  // so a re-order (which rebuilds the folders) keeps whatever was closed.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const expanded = useMemo(
    () => new Set(folderIds.filter((id) => !collapsed.has(id))),
    [folderIds, collapsed],
  );
  const allCollapsed = collapsed.size > 0;

  // The headline figure for the change being read. It counts exactly the
  // diff this tab holds, so it takes the same green/red as the files below.
  // Absent when no file recorded a count — a zero would claim "nothing
  // changed" about a change whose size simply isn't known.
  const totals = useMemo(() => {
    let adds = 0;
    let dels = 0;
    let known = false;
    for (const f of files) {
      const churn = fileChurn(f);
      if (!churn) continue;
      known = true;
      adds += churn.adds;
      dels += churn.dels;
    }
    return known ? { adds, dels } : null;
  }, [files]);

  const toggleAll = () => setCollapsed(allCollapsed ? new Set() : new Set(folderIds));

  return (
    <div className="ui-changes-files">
      <div className="ui-changes-files-bar">
        <span className="ui-changes-files-count">
          {fileOrder.length} {fileOrder.length === 1 ? "file" : "files"}
        </span>
        {totals ? <DiffCount added={totals.adds} removed={totals.dels} /> : null}
        <span className="ui-changes-spacer" />
        {sortable ? <SortMenu sort={sort} onSort={onSort} /> : null}
        {folderIds.length > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={toggleAll}
            title={allCollapsed ? "Expand all folders" : "Collapse all folders"}
          >
            {allCollapsed ? "Expand" : "Collapse"}
          </Button>
        ) : null}
      </div>
      <div className="ui-changes-files-scroll">
        <FileTree
          nodes={nodes}
          label="Changed files"
          selected={selected ?? undefined}
          onSelect={(node) => {
            if (!node.children) onSelect(node.id);
          }}
          expanded={expanded}
          onExpandedChange={(_next, node, open) =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (open) next.delete(node.id);
              else next.add(node.id);
              return next;
            })
          }
          rowProps={(node) => {
            if (!node.children) return { title: node.id };
            // A folder is not a change: its roll-up is said on hover, so the
            // colour in this tree marks exactly one thing — a changed file.
            const dir = node.id.replace(/^dir:/, "");
            const sum = folderSummary(files, dir);
            const lines = sum.adds > 0 || sum.dels > 0 ? ` · +${sum.adds} −${sum.dels}` : "";
            return {
              title: `${dir} · ${sum.count} ${sum.count === 1 ? "file" : "files"}${lines}`,
            };
          }}
        />
      </div>
    </div>
  );
}
