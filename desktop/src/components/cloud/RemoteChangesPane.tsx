// The Changes tab of a workspace on a machine — the local `ChangesTab`'s
// layout (the list and commit box on the left, the picked file's diff or the
// summary on the right) with one difference: "open in the editor" opens the
// file in THIS workspace's Files tab, not in the laptop's editor underneath.
//
// `ChangesTab` announces `aura:open-file` to the window, and the window's
// editor is the local one — hidden under this workspace and reading the
// laptop's copy. A remote workspace has its own Files tab, so the request
// goes there.

import { useState } from "react";

import { ChangesPanel } from "../rightrail/ChangesPanel";
import { ChangesSummaryPane } from "../git/ChangesSummaryPane";
import { WorkingDiffPane } from "../git/WorkingDiffPane";

export function RemoteChangesPane({
  repoRoot,
  onOpenFile,
}: {
  repoRoot: string;
  /** Open `path` in the workspace's Files tab. */
  onOpenFile: (path: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[340px] min-h-0 shrink-0 flex-col border-r border-line-soft">
        <ChangesPanel
          repoRoot={repoRoot}
          onOpenFile={(path, mode) => {
            // Cmd/Ctrl-click = "take me to the file"; a plain click reviews
            // the change here without leaving the list.
            if (mode === "edit") onOpenFile(path);
            else setSelected(path);
          }}
        />
      </div>
      <div className="min-w-0 min-h-0 flex-1">
        {selected ? (
          <WorkingDiffPane
            repoRoot={repoRoot}
            path={selected}
            onOpenInEditor={() => onOpenFile(selected)}
          />
        ) : (
          <ChangesSummaryPane repoRoot={repoRoot} />
        )}
      </div>
    </div>
  );
}
