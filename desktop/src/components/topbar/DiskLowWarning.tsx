// The line that says the disk is nearly full, under the CPU / memory figures.
//
// One sentence and one action. "Clean up" reveals the folder where Aura keeps
// every agent's copy of the project — the place that grows without anyone
// watching it — so the person can see what is there and throw out what they
// no longer need. There is no automatic prune: a copy holds someone's
// uncommitted work until it does not, and that is not a call to make for them.

import { FolderOpen } from "lucide-react";
import { api } from "../../lib/api";
import { diskWarning, type DiskFigures } from "../../lib/diskWarning";
import { Button } from "../ui/button";

export function DiskLowWarning({
  snap,
}: {
  snap: (DiskFigures & { copies_root?: string }) | null;
}) {
  const warning = diskWarning(snap);
  if (!warning) return null;
  const folder = snap?.copies_root?.trim() ?? "";
  const cleanUp = () => {
    if (!folder) return;
    api.fsRevealInFinder(folder).catch(() => {
      /* the folder may not exist yet — nothing to reveal, nothing to say */
    });
  };
  return (
    <div
      role="status"
      className="mx-3 my-2 flex items-center gap-2 rounded border border-amber/30 bg-amber/10 px-2.5 py-1.5 text-xs text-amber"
    >
      <span className="flex-1 truncate" title={`${warning.freePercent}% of the volume is free`}>
        {warning.message}
      </span>
      {folder && (
        <Button
          variant="outline"
          size="xs"
          onClick={cleanUp}
          title="Show the folder Aura keeps project copies in, so you can throw out old ones"
        >
          <FolderOpen />
          Clean up
        </Button>
      )}
    </div>
  );
}
