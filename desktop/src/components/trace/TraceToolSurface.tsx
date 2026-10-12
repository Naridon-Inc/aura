// The open Trace verify tool, rendered inline.
//
// Lifted out of WorkSurface so both entrances can render it: the workpane
// (a Trace tool restored from a saved layout) and the Trace page. It was a
// private function in a 2,500-line file, which is the only reason the page
// could not have it — nothing about it is pane-specific.
//
// The dialog components share the `Dialog` scaffold's `inline` flag, so the
// same component backs both the (legacy) modal and this surface — no body fork.

import type { JSX } from "react";

import { ReviewDialog } from "../dialogs/ReviewDialog";
import { AttestationsDialog } from "../dialogs/AttestationsDialog";
import { DoctorDialog } from "../dialogs/DoctorDialog";
import { TimeMachinePane } from "../workpanes/TimeMachinePane";
import { ImpactsPane } from "../workpanes";
import type { TraceToolKind } from "../../lib/editorStore";

export function TraceToolSurface({
  tool,
  arg,
  repoRoot,
  onClose,
}: {
  tool: TraceToolKind;
  arg: { identifier?: string; file?: string } | null;
  repoRoot: string;
  onClose: () => void;
}): JSX.Element {
  if (tool === "review") {
    return <ReviewDialog inline open repoRoot={repoRoot} onClose={onClose} />;
  }
  if (tool === "rewind") {
    // The old by-name Rewind form is replaced by the meaning-first Time
    // machine: a timeline of every moment your code changed, with one-click
    // bring-back of a single piece. Same engine call (`aura rewind`), same
    // right-click prefill (identifier + file) — just a recovery surface a
    // non-engineer can actually navigate.
    return (
      <TimeMachinePane
        repoRoot={repoRoot}
        defaultIdentifier={arg?.identifier ?? null}
        defaultFile={arg?.file ?? null}
        onExpand={() =>
          window.dispatchEvent(
            new CustomEvent("aura:open-time-machine", {
              detail: { identifier: arg?.identifier ?? null, file: arg?.file ?? null },
            }),
          )
        }
      />
    );
  }
  if (tool === "attest") {
    return <AttestationsDialog inline open repoRoot={repoRoot} onClose={onClose} />;
  }
  if (tool === "impacts") {
    // Cross-branch live impacts — the real home of cross-branch danger now
    // that the fake pr-review wall is gone. Reuses the same ImpactsPane the
    // sidebar tab renders (one component, one data source).
    return <ImpactsPane repoRoot={repoRoot} />;
  }
  // Project health, and the arm every other kind falls through to. Nothing on
  // screen opens it any more (see `PROJECT_HEALTH_ENABLED`); a saved
  // `{ tool: "doctor" }` link does, and a reading of what is wrong with the
  // repo is the least surprising thing to find at the end of this chain.
  return <DoctorDialog inline open repoRoot={repoRoot} onClose={onClose} />;
}
