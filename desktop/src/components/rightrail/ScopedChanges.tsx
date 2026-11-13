// The Changes tab's list when a wider scope than "uncommitted" is picked —
// everything against the target branch, or one commit. These files are
// committed, so the rows open the file and copy its path; there is nothing to
// stage or discard.

import type { BranchDiffFile } from "../../lib/api";
import { FileTree } from "../ui/file-tree";
import { FileActionsMenu } from "../ui/file-actions-menu";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { changeNodes, nodeId } from "./changeNodes";
import { ChangePath } from "./ChangePath";
import { matchesRailFilter } from "./railFilter";

const MODE = "scope";

export function ScopedChanges({
  files,
  error,
  filter,
  selected,
  onOpen,
}: {
  files: BranchDiffFile[] | null;
  error: string | null;
  filter: string;
  selected: string | null;
  onOpen: (path: string) => void;
}) {
  if (files === null) {
    return (
      <div className="ui-details-caption">
        <AsciiSpinner /> Reading changes…
      </div>
    );
  }
  if (error) return <div className="ui-details-caption">Couldn't read these changes: {error}</div>;
  const shown = files.filter((f) => matchesRailFilter(f.path, filter));
  if (shown.length === 0) {
    return (
      <div className="ui-details-caption">
        {files.length === 0 ? "No changes in this scope." : "No file matches the filter."}
      </div>
    );
  }
  const nodes = changeNodes(shown, MODE);
  // The row draws the whole path; what opens, and what is copied, is the
  // path the row stands for.
  const pathOf = (node: { id: string }) => node.id.slice(MODE.length + 1);
  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});
  return (
    <div className="ui-details-change-list">
      <FileTree
        nodes={nodes}
        label="Changed files"
        selected={selected ? nodeId(MODE, selected) : undefined}
        renderName={(node) => <ChangePath path={pathOf(node)} />}
        onSelect={(node) => onOpen(pathOf(node))}
        wrapRow={(node, row) => (
          <FileActionsMenu onView={() => onOpen(pathOf(node))} onCopyRelativePath={() => copy(pathOf(node))}>
            {row}
          </FileActionsMenu>
        )}
      />
    </div>
  );
}
