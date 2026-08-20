// Per-member cloud usage, fetched once for the surfaces that show it.
//
// `cloud_billing_usage_by_member` is a network round-trip to the billing
// service for a month's spend broken down by teammate. Three surfaces show
// it, none of them knowing about the others:
//
//   Overview        on mount
//   Cost & usage    on mount
//   Settings → Team on mount
//
// Overview and Cost & usage are two tabs of the same workpane strip and are
// routinely open together, so arriving at the app asked billing the same
// question twice over the network before anything was drawn. Opening Settings
// made it three.
//
// Unlike the ambient reads, this one is not on a timer — every caller fetches
// on mount and then leaves it alone. So the window is not sized under a poll;
// it is sized to cover "the mounts that happen while you arrive somewhere",
// which is seconds, against a figure that moves in cents per hour. A minute
// is generous for the first and invisible against the second.
//
// KEYED BY MONTH, not by repo. This is an org-wide figure — the same answer
// whichever project you have open — so the key is the month asked for, and
// the default (no month) is its own key rather than being folded into
// whichever month that happens to be today. Two callers asking for different
// months must not share an answer.

import { api, type BillingUsageByMember } from "./api";
import { dropShared, readShared, sharedReader } from "./sharedRead";

/** Long enough to cover the mounts of arriving somewhere, short enough that
 *  a figure in dollars is never meaningfully behind. */
const FRESH_MS = 60_000;

/** The key a bare "this month" read uses. Not today's month string: the
 *  server decides what "current" means, and pinning it here would make an
 *  explicit request for this month collide with the implicit one. */
const CURRENT = " current";

const usage = sharedReader(
  (month: string) =>
    api.cloudBillingUsageByMember(month === CURRENT ? undefined : month),
  FRESH_MS,
);

/** Per-member spend for `month` (or the current month). Shared with the other
 *  surfaces showing the same figure.
 *
 *  Rejects if billing could not be reached. Every caller already catches this
 *  and falls back to its solo view — "no usage" and "we couldn't ask" look
 *  identical on screen but mean opposite things, so this layer never turns
 *  one into the other. */
export function fetchBillingUsage(
  month?: string,
): Promise<BillingUsageByMember> {
  return readShared(usage, month ?? CURRENT);
}

/** Forget what was read, so the next surface asks for real. For after
 *  anything that changes the org's billing shape — a plan change, a member
 *  added or removed. */
export function invalidateBillingUsage(month?: string): void {
  dropShared(usage, month === undefined ? undefined : month);
}
