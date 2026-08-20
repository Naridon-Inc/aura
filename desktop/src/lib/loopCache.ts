// loopCache — the crew's ready-view, asked once per instant.
//
// `loop_ready_view` opens the loop graph and, before answering, re-arms any
// node left `working` by an app that died mid-run — a write, on every read.
// Five surfaces ask for it: BuildNav in the chrome (every 10s), the work rail's
// groups (every 30s), the crew board (every 4s while an agent is running, 12s
// when idle), the task detail pane's crew activity, and the manager's loop
// panel. Those cadences are not aligned with each other, so the overlaps are
// not occasional — three of those surfaces are on screen together whenever
// somebody is watching their crew work, which is exactly when the graph is
// being written to.
//
// Same rule as the task board, for the same reason: no freshness window. Every
// one of those surfaces also moves nodes — set a status, run natively, sync the
// board — and re-reads immediately to show what happened. An answer held in
// memory would only need to outlive one of those writes to show a run that
// didn't start. What is safe, and what actually costs here, is collapsing the
// reads that are in flight at the same moment into one.

import { api, type ReadyViewDto } from "./api";
import { readShared, sharedReader } from "./sharedRead";

/** Zero window — the graph is written to by the same surfaces that read it.
 *  See the header. */
const COALESCE_ONLY = 0;

const readyView = sharedReader(
  (repoRoot: string) => api.loopReadyView(repoRoot),
  COALESCE_ONLY,
);

/** The crew's ready view for a repo, shared with whoever else is asking right
 *  now. Rejects if the graph could not be read — an empty view means "no work
 *  queued", and that is not what a failed read should say. */
export function fetchReadyView(repoRoot: string): Promise<ReadyViewDto> {
  return readShared(readyView, repoRoot);
}
