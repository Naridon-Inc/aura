// ChangesTab — the "what you're about to save" surface, planned as master /
// detail instead of a lone sidebar. Left: the real ChangesPanel in its
// staging form (Staged / Changes, each nested repository under its own
// heading, live-sync awareness) with the commit box under it.
// Right: the picked file's diff inline, or — with nothing picked — a calm read
// of where your uncommitted work stands. A plain click reviews in place; a
// Cmd/Ctrl-click opens the file in the editor (and closes the surface) for
// those who want the full editor.

import { useState } from "react";

import { useGitChanges } from "../../lib/useGitChanges";
import { ChangesPanel } from "../rightrail/ChangesPanel";
import { CommitInput } from "../rightrail/CommitInput";
import { ChangesSummaryPane } from "./ChangesSummaryPane";
import { WorkingDiffPane } from "./WorkingDiffPane";
import "../ui/changes-tab.css";

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
  const changes = useGitChanges(repoRoot);
  // Bumped after a commit, push or pull so the box re-reads ahead/behind.
  const [refreshTick, setRefreshTick] = useState(0);

  const openInEditor = (path: string) => {
    window.dispatchEvent(new CustomEvent("aura:open-file", { detail: { path } }));
    onClose();
  };

  return (
    <div className="ui-changes-tab">
      {/* Left — the file list, then the commit box. */}
      <div className="ui-changes-tab-list">
        <div className="ui-changes-tab-files">
          <ChangesPanel
            repoRoot={repoRoot}
            staging
            onBeforeCommit={onBeforeCommit}
            onOpenFile={(path, mode) => {
              // Cmd/Ctrl-click = "take me to the editor"; a plain click reviews
              // the change here without leaving the Git view.
              if (mode === "edit") openInEditor(path);
              else setSelected(path);
            }}
          />
        </div>
        <CommitInput
          repoRoot={repoRoot}
          hasStagedChanges={changes.staged.length > 0}
          refreshTick={refreshTick}
          onBeforeCommit={onBeforeCommit}
          onAfterMutation={() => {
            void changes.refresh();
            setRefreshTick((t) => t + 1);
          }}
        />
      </div>

      {/* Right — review the picked file, or the at-a-glance summary. */}
      <div className="ui-changes-tab-view">
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
