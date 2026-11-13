// What an empty split pane shows: the starts grid, and through "More…" the
// app's one launcher (launcher/Launcher.tsx), filling the pane. The ＋ on a
// tab strip opens the same starts as a menu (workpanes/NewTabMenu.tsx).
//
// The only thing the hosts disagree about is where a pick lands: an empty
// pane replaces its own slot, a ＋ adds a tab to its leaf.

import { useEditorStore, type WorkPaneRef } from "../lib/editorStore";
import { EmptyPaneActions } from "./workpanes/EmptyPaneActions";

export function EmptyPanePicker({
  paneIndex,
  currentRepoRoot,
  onClosePane,
}: {
  paneIndex: number;
  /** Current workspace root — labels foreign rows and is the default project
   *  anything started here opens in. */
  currentRepoRoot: string;
  onClosePane: () => void;
}) {
  const store = useEditorStore();
  return (
    <EmptyPaneActions
      repoRoot={currentRepoRoot}
      place={(ref: WorkPaneRef) => store.replaceSplitPaneAt(paneIndex, ref)}
      onClosePane={onClosePane}
    />
  );
}
