// "See why" on the one line Create PR's hidden checks leave when something
// failed: the detail each check already has on Trace.

import type { PrGuardKind } from "../../lib/prGuards";
import { goToTrace } from "../trace/traceRoute";

export function openPrGuardDetail(kind: PrGuardKind): void {
  if (kind === "goals") goToTrace({ kind: "prove" });
  else goToTrace({ kind: "tool", tool: kind === "safety" ? "review" : "attest" });
}
