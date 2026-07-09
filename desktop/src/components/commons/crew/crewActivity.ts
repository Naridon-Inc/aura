// crewActivity — turns the partitioned ready_view into one reverse-chronological
// feed: "what is my crew doing, and what did it just do?" Pure and deterministic
// (no Date/random) so it's testable and renders the same every time.
//
// Working nodes float to the top (they're live), then finished and failed nodes
// fall newest-first by `updated_at`. The Activity tab filters this list; the
// detail drawer reads the same task objects.

import type { LoopTask, ReadyViewDto } from "../../../lib/api";

export type CrewActivityKind = "working" | "done" | "failed";

export type CrewActivityItem = {
  task: LoopTask;
  kind: CrewActivityKind;
};

export function buildActivityFeed(view: ReadyViewDto): CrewActivityItem[] {
  const items: CrewActivityItem[] = [];
  for (const t of view.working) items.push({ task: t, kind: "working" });
  for (const t of view.done) items.push({ task: t, kind: "done" });
  // Failures live in `other` (status "failed") — surface them so a stuck run is
  // never silent. A node carrying an error message counts even if its status
  // drifted.
  for (const t of view.other) {
    if (t.status === "failed" || (t.error_message ?? "").trim()) {
      items.push({ task: t, kind: "failed" });
    }
  }
  return items.sort((a, b) => {
    // Live work always on top, regardless of timestamps.
    const wa = a.kind === "working" ? 1 : 0;
    const wb = b.kind === "working" ? 1 : 0;
    if (wa !== wb) return wb - wa;
    return (b.task.updated_at ?? 0) - (a.task.updated_at ?? 0);
  });
}
