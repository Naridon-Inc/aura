// The PRs tab of a workspace on a machine: the project's pull requests, and
// the button that opens one from the branch checked out over there.
//
// Both take `repoRoot` — the local root the place is keyed by — and route
// themselves; the forge is the same forge wherever the checkout is, and the
// branch the button offers is read off the box. A PR opened from the list
// goes to the app-level detail surface, which sits above this workspace.

import { CreatePrButton } from "../rightrail/CreatePrButton";
import { PrRailPanel } from "../rightrail/PrRailPanel";

export function RemotePrsPane({ repoRoot }: { repoRoot: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-line-soft px-3 py-1.5">
        <span className="text-xs text-text-4">Pull requests for this project</span>
        <CreatePrButton repoRoot={repoRoot} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PrRailPanel repoRoot={repoRoot} />
      </div>
    </div>
  );
}
