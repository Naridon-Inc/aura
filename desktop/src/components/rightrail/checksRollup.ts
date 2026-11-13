// The Checks tab's CI, deploy and comment rows in a few words each. A failed
// check gets a row of its own, because each one is something to fix; the
// running ones and the passed ones are a count apiece. PURE, so a test can
// hand it what the panel read.

import type { PrCheck, VercelDeployment } from "../../lib/api";
import { bucketOf } from "../pr/checks/PrCheckRows";
import type { DetailsCheckStatus } from "../ui/details-checks";

export type ChecksRollup = { failed: PrCheck[]; running: PrCheck[]; passed: PrCheck[] };

/** Split the checks three ways, keeping GitHub's order within each. */
export function rollUpChecks(checks: PrCheck[]): ChecksRollup {
  const out: ChecksRollup = { failed: [], running: [], passed: [] };
  for (const c of checks) {
    const bucket = bucketOf(c);
    if (bucket === "failure") out.failed.push(c);
    else if (bucket === "success") out.passed.push(c);
    else out.running.push(c);
  }
  return out;
}

/** "1 check running", "4 checks passed", "3 comments". */
export function countLine(n: number, noun: string, verb = ""): string {
  const words = `${n} ${noun}${n === 1 ? "" : "s"}`;
  return verb ? `${words} ${verb}` : words;
}

/** What a check row says on hover: why it didn't start, when GitHub said,
 *  else where it ran and its own line, then GitHub's status word. */
export function checkHint(c: PrCheck): string {
  const reason = c.failure_reason?.trim() ?? "";
  const where = c.workflow && c.workflow !== c.name ? c.workflow : "";
  const line = reason ? `Didn't start. ${reason}` : [where, c.description].filter(Boolean).join(" · ");
  return [line, `GitHub status: ${c.raw}`].filter(Boolean).join("\n");
}

/** A check that never started has a setup problem, not a code one: its log
 *  is what to read, and a chat can't fix it from the branch. */
export function fixableInBranch(c: PrCheck): boolean {
  return !(c.failure_reason?.trim());
}

const DEPLOY_STATE: Record<string, { word: string; status: DetailsCheckStatus }> = {
  READY: { word: "deployed", status: "passed" },
  BUILDING: { word: "building", status: "running" },
  INITIALIZING: { word: "starting", status: "running" },
  QUEUED: { word: "queued", status: "running" },
  ERROR: { word: "deploy failed", status: "failed" },
  CANCELED: { word: "deploy canceled", status: "pending" },
};

/** The deployment as one row: "Preview deployed", with Open while there is
 *  a page to open and Build (the deploy's log) otherwise. */
export function deployLine(d: VercelDeployment): {
  title: string;
  status: DetailsCheckStatus;
  action: { label: string; url: string } | null;
} {
  const env = d.target === "production" ? "Production" : "Preview";
  const state = DEPLOY_STATE[d.state] ?? { word: "deploy", status: "pending" as const };
  const action = d.url
    ? { label: "Open", url: `https://${d.url}` }
    : d.inspector_url
      ? { label: "Build", url: d.inspector_url }
      : null;
  return { title: `${env} ${state.word}`, status: state.status, action };
}
