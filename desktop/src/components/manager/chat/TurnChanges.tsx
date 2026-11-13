//! Per-round "what changed" receipt, shown at the foot of a settled turn.
//!
//! A small inline artifact under the answer — "1 file changed +30 −2" — gives a
//! glance-level receipt of what the turn did to your code without opening the
//! steps. `extractTurnChanges` folds the turn's persisted edit/write tool calls
//! into a per-file tally; opening the receipt shows the same before/after diffs
//! (`FileDiffTool`, the shared Monaco engine) the steps use, so reviewing the
//! round and opening a step show the identical diff.
//!
//! Plain language: "files changed" and +/− lines, no commit/stat/hunk jargon.

import { useState } from "react";
import { FileDiff } from "lucide-react";
import { ChatInlineArtifact } from "../../ui/chat-surface";
import { FileDiffTool } from "./FileDiffTool";
import type { TurnChangeSummary } from "./turnChangeSummary";
import { basename } from "../../../lib/paths";

/** The +/− pair, drawn as the shared diff count. */
function DiffCount({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="ui-diff-count">
      <span>+{added}</span>
      <span>−{removed}</span>
    </span>
  );
}

/** The round's change receipt. Closed: a one-line tally. Open: the per-file
 *  before/after diffs. The caller only mounts it when the turn changed a
 *  file, so a read-only or command-only turn shows no receipt. */
export function TurnChanges({ summary }: { summary: TurnChangeSummary }) {
  const [open, setOpen] = useState(false);
  const { files, filesChanged, added, removed } = summary;
  return (
    <div className="ui-chat-turn-changes">
      <ChatInlineArtifact
        icon={<FileDiff size={14} />}
        detail={<DiffCount added={added} removed={removed} />}
        expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={open ? "Hide the changes" : "Review the changes from this round"}
      >
        {filesChanged === 1 ? "1 file changed" : `${filesChanged} files changed`}
      </ChatInlineArtifact>
      {open && (
        <div className="ui-chat-turn-changes-files">
          {files.map((f, i) =>
            f.block ? (
              // A renderable edit/write call → the real before/after diff,
              // the same row the steps show.
              <FileDiffTool
                key={f.path + i}
                name={f.block.name}
                input={f.block.input}
                result={f.block.result}
              />
            ) : (
              // A multi-edit or patch with no single old/new pair to diff —
              // an honest one-line tally, no invented diff.
              <p key={f.path + i} className="ui-chat-turn-change" title={f.path}>
                <span>{basename(f.path) || f.path}</span>
                <DiffCount added={f.added} removed={f.removed} />
              </p>
            ),
          )}
        </div>
      )}
    </div>
  );
}
