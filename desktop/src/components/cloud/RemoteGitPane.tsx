// The Git tab of a workspace on a machine: the branch and sync controls, and
// the history underneath — the local `GitView` without its fullscreen frame,
// because here it is a tab in a strip, not an overlay over one.
//
// Everything in it takes `repoRoot` and asks through `lib/place/workApi`, so
// the branches it lists and the commits it draws are the checkout's on the
// box. The Changes half of the local view is its own tab here.

import { HistoryTab } from "../git/HistoryTab";
import { RepoHeaderControls } from "../git/RepoHeaderControls";

export function RemoteGitPane({ repoRoot }: { repoRoot: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-line-soft px-3 py-1.5">
        <span className="text-xs text-text-4">Branch on the machine</span>
        <RepoHeaderControls repoRoot={repoRoot} />
      </div>
      <div className="min-h-0 flex-1">
        <HistoryTab repoRoot={repoRoot} />
      </div>
    </div>
  );
}
