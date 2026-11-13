// The details column beside an opened run: the facts about it, and the files
// it touched as the same tree a workspace lists its changes in. Picking a file
// opens it under Review changes.

import { useMemo, useState } from "react";
import { GitBranch, Lock } from "lucide-react";
import type { IntentChangesetFile, IntentRow } from "../../lib/api";
import { agentDisplayLabel, canonicalAgentId } from "../../lib/agentIdentity";
import { intentTypeChip } from "@shared/intentTypeLabels";
import { DiffCount } from "../ui/sidebar";
import { FileTree, type FileTreeNode } from "../ui/file-tree";
import { TraceAside, TraceAsidePanel, TraceCaption, TraceFact, TraceNote } from "../ui/trace-detail";
import { TraceMark } from "../ui/trace-list";
import { AgentMark } from "./AgentMark";
import type { SessionDetail } from "./useSessionDetail";

type AsideTab = "details" | "changes";

function fileStatus(status: string | undefined): FileTreeNode["status"] {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "added" || s === "a" || s === "new") return "added";
  if (s === "deleted" || s === "d" || s === "removed") return "deleted";
  return "modified";
}

/** Changed files as folders and leaves. A leaf's id is its path, so a pick
 *  names the file to open. */
function changeTree(files: IntentChangesetFile[]): { nodes: FileTreeNode[]; folders: string[] } {
  const root: FileTreeNode[] = [];
  const folders: string[] = [];
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = f.path.split("/").filter(Boolean);
    let level = root;
    let prefix = "";
    parts.slice(0, -1).forEach((part) => {
      prefix = prefix ? `${prefix}/${part}` : part;
      const id = `dir:${prefix}`;
      let dir = level.find((n) => n.id === id);
      if (!dir) {
        dir = { id, name: part, children: [] };
        level.push(dir);
        folders.push(id);
      }
      level = dir.children!;
    });
    level.push({
      id: f.path,
      name: parts[parts.length - 1] ?? f.path,
      status: fileStatus(f.status),
      added: typeof f.additions === "number" ? f.additions : undefined,
      removed: typeof f.deletions === "number" ? f.deletions : undefined,
    });
  }
  return { nodes: root, folders };
}

export function SessionDetailAside({
  row,
  detail,
  selectedFile,
  onOpenFile,
}: {
  row: IntentRow;
  detail: SessionDetail;
  selectedFile: string | null;
  onOpenFile: (path: string) => void;
}) {
  const { files, churn, isBlocked, signed, depth, rel, whenAbsolute } = detail;
  const [tab, setTab] = useState<AsideTab>("details");
  const tree = useMemo(() => changeTree(files), [files]);
  const where = row.branch || row.worktree;
  const whereTitle = row.branch
    ? `Worked on the ${row.branch} branch${row.worktree ? ` in the ${row.worktree} folder` : ""}`
    : row.worktree
      ? `Worked on in the ${row.worktree} folder`
      : undefined;
  const agent = agentDisplayLabel(canonicalAgentId(row.agent_id) || row.agent_id);
  const tabs = isBlocked
    ? [{ id: "details" as const, label: "Details" }]
    : [
        { id: "details" as const, label: "Details" },
        { id: "changes" as const, label: "Changes", count: files.length },
      ];

  return (
    <TraceAside
      label="Run details"
      value={tab}
      onChange={setTab}
      tabs={tabs}
      top={
        <>
          <GitBranch size={14} aria-hidden />
          {/* Stamped when the row was written: the branch the work was done
              on, not wherever the reader is standing. */}
          <span className="ui-trace-aside-where" title={whereTitle}>
            {where || "No branch recorded"}
          </span>
          {churn.hasChurn && <DiffCount added={churn.adds} removed={churn.dels} />}
        </>
      }
    >
      <TraceAsidePanel value="details">
        <TraceCaption>About this run</TraceCaption>
        <TraceFact label="Agent">
          <AgentMark agentId={row.agent_id} />
          {agent}
        </TraceFact>
        <TraceFact label="When" title={whenAbsolute}>
          {rel} ago · {whenAbsolute}
        </TraceFact>
        {depth.length > 0 && <TraceFact label="Work">{depth.join(" · ")}</TraceFact>}
        {where && (
          <TraceFact label="Where" title={whereTitle}>
            {where}
          </TraceFact>
        )}
        {detail.changeset && (
          <TraceFact label="Files">
            {files.length} {files.length === 1 ? "file" : "files"}
          </TraceFact>
        )}
        {/* Blocked is not a category but a state to act on, so it wears the
            danger ink the other kinds don't. */}
        {row.intent_type && (
          <TraceFact label="Kind">
            {row.intent_type === "blocked" ? (
              <TraceMark tone="danger">Blocked</TraceMark>
            ) : (
              intentTypeChip(row.intent_type)
            )}
          </TraceFact>
        )}
        {signed && (
          <TraceFact label="Record" title={row.key_id ? `Signed with key ${row.key_id}` : "Signed"}>
            <Lock aria-hidden />
            Signed
          </TraceFact>
        )}
      </TraceAsidePanel>
      {!isBlocked && (
        <TraceAsidePanel value="changes">
          {files.length === 0 ? (
            <TraceNote title="No file changes">
              Nothing this run changed was recorded.
            </TraceNote>
          ) : (
            <>
              <TraceCaption
                trailing={
                  churn.hasChurn ? <DiffCount added={churn.adds} removed={churn.dels} /> : null
                }
              >
                Changed files
              </TraceCaption>
              <FileTree
                nodes={tree.nodes}
                label="Changed files"
                defaultExpanded={tree.folders}
                selected={selectedFile ?? undefined}
                onSelect={(node) => {
                  if (!node.children) onOpenFile(node.id);
                }}
              />
            </>
          )}
        </TraceAsidePanel>
      )}
    </TraceAside>
  );
}
