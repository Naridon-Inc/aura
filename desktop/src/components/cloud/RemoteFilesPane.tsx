// The Files tab of a workspace on a machine: the project's tree down the
// left and the picked file in an editor on the right.
//
// `FileTree` already knows a root that is on a machine (it lists through
// `lib/place/workApi` and re-lists on a timer, since no watcher runs over
// there); the editor beside it reads and writes the same way. Neither
// touches the laptop's copy of the project.

import { FileTree } from "../FileTree";
import { RemoteFileEditor } from "./RemoteFileEditor";

export function RemoteFilesPane({
  repoRoot,
  machineName,
  openFile,
  onOpenFile,
}: {
  repoRoot: string;
  machineName: string;
  openFile: string | null;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-60 min-h-0 shrink-0 flex-col border-r border-line-soft">
        <FileTree root={repoRoot} selected={openFile} onSelect={onOpenFile} />
      </div>
      <div className="min-w-0 min-h-0 flex-1">
        {openFile ? (
          <RemoteFileEditor
            key={openFile}
            repoRoot={repoRoot}
            path={openFile}
            machineName={machineName}
          />
        ) : (
          <div className="px-4 py-3 text-sm text-text-3">
            Pick a file to read it from {machineName}.
          </div>
        )}
      </div>
    </div>
  );
}
