// TimelineWizard — the full-screen home for the Project Timeline.
//
// Reliving how a project evolved deserves the whole window, the same way the
// Time machine and Extensions do: a FullscreenOverlay that hands the timeline
// the full canvas so the bottom scrubber has room to breathe and the moment
// detail reads like a page, not a squeezed Trace tool pane. Summoned from the
// Trace rail (or anywhere via `aura:open-timeline`), Esc or "Done" to leave.
//
// No title — per the FullscreenOverlay contract the surface never shows one;
// the TimelinePane carries its own "Project timeline" masthead.

import { FullscreenOverlay } from "../../FullscreenOverlay";
import { TimelinePane } from "./TimelinePane";

export function TimelineWizard({
  repoRoot,
  onClose,
}: {
  repoRoot: string;
  onClose: () => void;
}) {
  // No "Done" footer: the Timeline carries its own transport + scrubber along
  // the bottom, so a generic wizard action bar would be a redundant second bar.
  // The overlay's own ✕ / Esc (top-left) is the way out.
  return (
    <FullscreenOverlay onClose={onClose} contentClassName="bg-bg-content">
      <TimelinePane repoRoot={repoRoot} />
    </FullscreenOverlay>
  );
}
