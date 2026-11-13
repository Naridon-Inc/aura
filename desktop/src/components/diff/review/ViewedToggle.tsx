// The Viewed toggle at the right end of a diff's header: a box that is ticked
// while the file's change is the one marked as viewed on this device.

import { Check } from "lucide-react";

import { Button } from "../../ui/button";
import { Tooltip } from "../../ui/tooltip";

export function ViewedToggle({ viewed, onToggle }: { viewed: boolean; onToggle: () => void }) {
  return (
    <Tooltip content={viewed ? "Mark as not viewed" : "Mark as viewed"}>
      <Button
        variant="ghost"
        size="sm"
        className="ui-diff-viewed"
        aria-pressed={viewed}
        onClick={onToggle}
      >
        <span className="ui-diff-viewed-box" aria-hidden>
          {viewed && <Check size={12} />}
        </span>
        Viewed
      </Button>
    </Tooltip>
  );
}
