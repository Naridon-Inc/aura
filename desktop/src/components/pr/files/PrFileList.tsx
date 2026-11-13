// The Files tab's list of what the pull request touches, as the shared file
// tree: folders folded the way the Changes tab folds them, each file's +/−,
// how many safety-check findings name it, and whether it's been viewed.

import { useMemo, useState, type HTMLAttributes } from "react";
import { Check } from "lucide-react";
import type { PrFileStat } from "../../../lib/api";
import { Button } from "../../ui/button";
import { FileTree, type FileTreeNode } from "../../ui/file-tree";
import { DiffCount } from "../../ui/sidebar";
import { TraceMark } from "../../ui/trace-list";
import { buildChangeTree, folderSummary } from "../../trace/changes/changeTree";
import "../../ui/pr-files.css";

/** A pull request's file list carries no per-file status, so the tree draws
 *  none rather than calling every file "modified". */
function withoutStatus(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map(({ status: _status, statusLabel: _label, children, ...rest }) =>
    children ? { ...rest, children: withoutStatus(children) } : rest,
  );
}

export function PrFileList({
  files,
  activePath,
  onSelect,
  viewedPaths,
  findingCounts,
}: {
  files: PrFileStat[];
  activePath: string | null;
  onSelect: (path: string) => void;
  /** Files the reader has marked Viewed. */
  viewedPaths: Set<string>;
  /** Safety-check findings that name each file — a file with none reads clean. */
  findingCounts: Map<string, number>;
}) {
  const { nodes, folderIds } = useMemo(() => {
    const tree = buildChangeTree(files, "path");
    return { nodes: withoutStatus(tree.nodes), folderIds: tree.folderIds };
  }, [files]);
  // Everything starts open; the reader closes folders. Kept as the closed set
  // so a refresh (which rebuilds the folders) keeps whatever was closed.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const expanded = useMemo(
    () => new Set(folderIds.filter((id) => !collapsed.has(id))),
    [folderIds, collapsed],
  );
  const allCollapsed = collapsed.size > 0;

  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const f of files) {
      added += f.additions;
      removed += f.deletions;
    }
    return { added, removed };
  }, [files]);
  const viewed = useMemo(
    () => files.reduce((n, f) => (viewedPaths.has(f.path) ? n + 1 : n), 0),
    [files, viewedPaths],
  );

  return (
    <div className="ui-pr-files">
      <div className="ui-pr-files-bar">
        <span className="ui-pr-files-count">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <DiffCount added={totals.added} removed={totals.removed} />
        {viewed > 0 && (
          <span className="ui-pr-files-viewed" title={`${viewed} of ${files.length} files viewed`}>
            {viewed}/{files.length} viewed
          </span>
        )}
        <span className="ui-pr-files-spacer" />
        {folderIds.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(folderIds))}
            title={allCollapsed ? "Expand all folders" : "Collapse all folders"}
          >
            {allCollapsed ? "Expand" : "Collapse"}
          </Button>
        )}
      </div>
      <div className="ui-pr-files-scroll">
        {files.length === 0 ? (
          <p className="ui-pr-files-empty">No files in this pull request.</p>
        ) : (
          <FileTree
            nodes={nodes}
            label="Files in this pull request"
            selected={activePath ?? undefined}
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
              if (node.children) {
                const dir = node.id.replace(/^dir:/, "");
                const sum = folderSummary(files, dir);
                return {
                  title: `${dir} · ${sum.count} ${sum.count === 1 ? "file" : "files"} · +${sum.adds} −${sum.dels}`,
                };
              }
              return {
                title: node.id,
                "data-viewed": viewedPaths.has(node.id) ? "" : undefined,
              } as HTMLAttributes<HTMLDivElement>;
            }}
            renderName={(node) => {
              if (node.children) return node.name;
              const found = findingCounts.get(node.id) ?? 0;
              return (
                <>
                  <span className="ui-pr-files-name">{node.name}</span>
                  {found > 0 && (
                    <TraceMark tone="warn" title="Safety-check findings that name this file">
                      {found}
                    </TraceMark>
                  )}
                  {viewedPaths.has(node.id) && (
                    <Check className="ui-pr-files-check" aria-label="Viewed" />
                  )}
                </>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
