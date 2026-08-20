// The one place a trace tool gets its human name.
//
// There were two independent copies of this mapping — one in the default tab
// strip, one in the split-view strip — and both were written as a ternary
// chain ending in a bare `: "Project health"`. So the sixth tool, `impacts`,
// matched no arm and inherited that trailing default: opening "Impacts on me"
// produced a tab labelled "Project health", in both strips, silently, because
// a fallthrough default can't be type-checked for missing cases.
//
// A `Record<TraceToolKind, string>` can. Add a tool to the union and this file
// stops compiling until it has a name.

import type { TraceToolKind } from "./editorStore";

export const TRACE_TOOL_LABEL: Record<TraceToolKind, string> = {
  review: "Safety check",
  rewind: "Time machine",
  attest: "Genuine record",
  memory: "Memory",
  doctor: "Project health",
  impacts: "Impacts on me",
};

/** Human name for a trace tool — the same words its sidebar row uses. */
export function traceToolLabel(kind: TraceToolKind): string {
  return TRACE_TOOL_LABEL[kind];
}
