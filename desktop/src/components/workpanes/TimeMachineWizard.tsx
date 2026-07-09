// TimeMachineWizard — the full-screen home for the Time machine.
//
// The timeline-and-detail recovery experience (TimeMachinePane) earns its own
// focus surface, the same way Extensions did: a FullscreenOverlay that owns the
// whole window so travelling back to a past moment is an immersive act, not a
// glance at a squeezed Trace tool pane. This is the "Rewind-inspired wizard" —
// summoned from anywhere (⌘⌥T, the command palette, or the pane's expand
// affordance), Esc or "Done" to leave.
//
// No title — per the FullscreenOverlay contract the surface never shows one;
// the pane carries its own "Time machine" header. The SAME TimeMachinePane is
// reused (one experience, never forked) — it just renders here at full size and
// without its own expand button (we're already maximised).

import { FullscreenOverlay } from "../FullscreenOverlay";
import { Button } from "../ui/button";
import { TimeMachinePane } from "./TimeMachinePane";

export function TimeMachineWizard({
  repoRoot,
  defaultIdentifier,
  defaultFile,
  onClose,
}: {
  repoRoot: string;
  defaultIdentifier?: string | null;
  defaultFile?: string | null;
  onClose: () => void;
}) {
  return (
    <FullscreenOverlay
      onClose={onClose}
      footer={
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      }
      contentClassName="bg-bg-content"
    >
      <TimeMachinePane
        repoRoot={repoRoot}
        defaultIdentifier={defaultIdentifier}
        defaultFile={defaultFile}
      />
    </FullscreenOverlay>
  );
}
