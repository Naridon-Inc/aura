// The pull request's Files tab: the file list, the selected file's meaning
// and patch, and a side column for review threads, the stack, and the safety
// check's findings.

import { useMemo } from "react";
import type { PrComment, PrDetail } from "../../../lib/api";
import { TraceAside, TraceAsidePanel } from "../../ui/trace-detail";
import { SplitDiffHeader, useStackedDiff } from "../../workpanes/SplitDiffHeader";
import { PrFindingsPanel } from "../findings/PrFindingsPanel";
import { PrStackView } from "../PrStackView";
import { PrThreadColumn, PrThreadProvider } from "../PrThreadColumn";
import { PrFileDiff, splitDiffByFile } from "./PrFileDiff";
import { PrFileDiffBar } from "./PrFileDiffBar";
import { PrFileList } from "./PrFileList";
import type { PrChangeStory } from "./usePrChangeStory";
import "../../ui/pr-files.css";

export type PrFilesAsideTab = "threads" | "stack" | "findings";

export function PrFilesTab({
  repoRoot,
  prNumber,
  detail,
  comments,
  changeStory,
  activePath,
  onSelectPath,
  viewedPaths,
  onToggleViewed,
  findingCounts,
  asideTab,
  onAsideTab,
  onCommentsChanged,
}: {
  repoRoot: string;
  prNumber: number;
  detail: PrDetail;
  comments: PrComment[];
  /** What the pull request did, per file, in words — empty when the range
   *  can't be read on this machine, and then the patch stands alone. */
  changeStory: PrChangeStory;
  activePath: string | null;
  onSelectPath: (path: string) => void;
  viewedPaths: Set<string>;
  onToggleViewed: (path: string, viewed: boolean) => void;
  findingCounts: Map<string, number>;
  asideTab: PrFilesAsideTab;
  onAsideTab: (tab: PrFilesAsideTab) => void;
  onCommentsChanged: () => void;
}) {
  const chunks = useMemo(() => splitDiffByFile(detail.diff ?? ""), [detail.diff]);
  // The patch sits between the file list and the side column, so it can be
  // narrow enough that Previous/New side by side stops being readable.
  const [diffRef, diffNarrow] = useStackedDiff();

  const activeFile = activePath ? (detail.files.find((f) => f.path === activePath) ?? null) : null;
  const activeNote = activePath ? (changeStory.noteByPath.get(activePath) ?? null) : null;
  const threadCount = comments.filter((c) => !c.is_issue_comment).length;

  return (
    <PrThreadProvider repoRoot={repoRoot} prNumber={prNumber} onPosted={onCommentsChanged}>
      <div className="ui-pr-files-tab">
        <PrFileList
          files={detail.files}
          activePath={activePath}
          onSelect={onSelectPath}
          viewedPaths={viewedPaths}
          findingCounts={findingCounts}
        />
        <div className="ui-pr-file-column">
          <PrFileDiffBar
            path={activePath}
            file={activeFile}
            viewed={activePath ? viewedPaths.has(activePath) : false}
            onToggleViewed={(v) => {
              if (activePath) onToggleViewed(activePath, v);
            }}
          />
          <div ref={diffRef} className="ui-pr-file-scroll">
            {activePath ? (
              <>
                {/* Meaning first, code second — the same order the Changes
                    tab uses for a commit. Absent when the range can't be
                    resolved on this machine; the patch below is then the
                    whole truth. */}
                {changeStory.range && activeNote && (
                  <SplitDiffHeader
                    note={activeNote}
                    when={changeStory.when}
                    author={changeStory.author}
                    repoRoot={repoRoot}
                    commit={changeStory.range}
                    stacked={diffNarrow}
                  />
                )}
                <PrFileDiff
                  repoRoot={repoRoot}
                  prNumber={prNumber}
                  filePath={activePath}
                  body={chunks.get(activePath) ?? ""}
                  comments={comments}
                  onPosted={onCommentsChanged}
                />
              </>
            ) : (
              <p className="ui-pr-files-empty">Pick a file to see what changed in it.</p>
            )}
          </div>
        </div>
        <TraceAside
          label="Review"
          tabs={[
            { id: "threads" as const, label: "Threads", count: threadCount || undefined },
            { id: "stack" as const, label: "Stack" },
            { id: "findings" as const, label: "Findings" },
          ]}
          value={asideTab}
          onChange={onAsideTab}
        >
          <TraceAsidePanel value="threads">
            {/* Thread cards float beside the diff lines they belong to. */}
            <div className="ui-pr-thread-lane">
              <PrThreadColumn />
            </div>
          </TraceAsidePanel>
          <TraceAsidePanel value="stack">
            <PrStackView repoRoot={repoRoot} prNumber={prNumber} />
          </TraceAsidePanel>
          <TraceAsidePanel value="findings">
            <PrFindingsPanel detail={detail} />
          </TraceAsidePanel>
        </TraceAside>
      </div>
    </PrThreadProvider>
  );
}
