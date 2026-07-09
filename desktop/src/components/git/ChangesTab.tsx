// ChangesTab — the "what you're about to save" surface, planned as master /
// detail instead of a lone sidebar. Left: the real ChangesPanel (staged /
// modified / untracked + the commit box + live-sync awareness), reused whole.
// Right: the picked file's diff inline, or — with nothing picked — a calm read
// of where your uncommitted work stands. A plain click reviews in place; a
// Cmd/Ctrl-click opens the file in the editor (and closes the surface) for
// those who want the full editor.

import { useState } from "react";

import { ChangesPanel } from "../rightrail/ChangesPanel";
import { ChangesSummaryPane } from "./ChangesSummaryPane";
import { WorkingDiffPane } from "./WorkingDiffPane";

export function ChangesTab({
  repoRoot,
  onClose,
  onBeforeCommit,
}: {
  repoRoot: string;
  onClose: () => void;
  /** Strict-mode readiness gate, forwarded to the commit box so a commit made
   *  from the Git view runs the same intent check as the sidebar/footer. */
  onBeforeCommit?: () => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  const openInEditor = (path: string) => {
    window.dispatchEvent(new CustomEvent("aura:open-file", { detail: { path } }));
    onClose();
  };

  return (
    <div className="flex h-full min-h-0">
      {/* Left — the file list + commit box, reused wholesale. */}
      <div className="flex w-[340px] min-h-0 shrink-0 flex-col border-r border-line-soft">
        <ChangesPanel
          repoRoot={repoRoot}
          onBeforeCommit={onBeforeCommit}
          onOpenFile={(path, mode) => {
            // Cmd/Ctrl-click = "take me to the editor"; a plain click reviews
            // the change here without leaving the Git view.
            if (mode === "edit") openInEditor(path);
            else setSelected(path);
          }}
        />
      </div>

      {/* Right — review the picked file, or the at-a-glance summary. */}
      <div className="min-w-0 min-h-0 flex-1">
        {selected ? (
          <WorkingDiffPane
            repoRoot={repoRoot}
            path={selected}
            onOpenInEditor={() => openInEditor(selected)}
          />
        ) : (
          <ChangesSummaryPane repoRoot={repoRoot} />
        )}
      </div>
    </div>
  );
}
