import { type CSSProperties, type ReactNode } from "react";
import { DiffCount } from "./sidebar";
export interface WorkspaceArtifact {
  id: string;
  title: string;
  type: string;
  preview?: ReactNode;
}
export function WorkspaceArtifacts({
  items,
  changes,
  onOpen,
  onChanges,
}: {
  items: WorkspaceArtifact[];
  changes?: { added: number; removed: number; files: number };
  onOpen: (id: string) => void;
  onChanges?: () => void;
}) {
  return (
    <div className="ui-workspace-artifacts" aria-label="Workspace artifacts">
      {changes && (
        <button className="ui-workspace-artifact" onClick={onChanges}>
          <div className="ui-workspace-artifact-preview">
            <div className="ui-diff-thumbnail" aria-hidden="true">
              {["neutral", "remove", "add", "add", "add", "neutral"].map((tone, index) => (
                <i
                  key={index}
                  data-tone={tone}
                  style={{ "--line-width": `${[60, 76, 52, 90, 44, 68][index]}%` } as CSSProperties}
                />
              ))}
            </div>
          </div>
          <div>
            <DiffCount added={changes.added} removed={changes.removed} />
            <small>{changes.files} files</small>
          </div>
          <span>Code changes</span>
        </button>
      )}
      {items.map((item) => (
        <button key={item.id} className="ui-workspace-artifact" onClick={() => onOpen(item.id)}>
          <div className="ui-workspace-artifact-preview">{item.preview}</div>
          <div>
            <small>{item.type}</small>
          </div>
          <span>{item.title}</span>
        </button>
      ))}
      {!changes && !items.length && <div className="ui-pattern-empty">No artifacts yet.</div>}
    </div>
  );
}
