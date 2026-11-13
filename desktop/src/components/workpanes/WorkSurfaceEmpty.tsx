// WorkSurface empty state — the surface you land on when a workspace opens
// and nothing is in it yet. It is an empty pane like any other: the starts
// grid, with "More…" for the launcher. Whatever is started drops into the
// slot the reader is looking at.

import { useEditorStore, type WorkPaneRef } from "../../lib/editorStore";
import { EmptyPaneActions } from "./EmptyPaneActions";

export function WorkSurfaceEmpty({ repoRoot }: { repoRoot: string }) {
  const store = useEditorStore();
  return (
    <EmptyPaneActions
      repoRoot={repoRoot}
      launcher="compact"
      place={(ref: WorkPaneRef) => store.replaceSplitPaneAt(0, ref)}
    />
  );
}
