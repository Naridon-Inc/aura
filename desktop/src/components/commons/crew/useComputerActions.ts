// What a person can do to the team's computer from any screen that shows it:
// move to a plan that includes one, start the one the plan includes, wake it,
// try a failed setup again, or give it a new size. One thing at a time; each
// answer is the computer as it is now, handed to every screen at once.

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import {
  auraComputerResize,
  auraComputerRetry,
  auraComputerStart,
  auraComputerWake,
  settingUp,
  upgradePlan,
  type AuraComputerStatus,
} from "../../../lib/auraComputer";
import { billingCheckout } from "../../../lib/cloudAdmin";
import { cloudOriginsNow } from "../../../lib/cloudOrigin";
import { messageOf } from "../../../lib/cloudOrgs";
import { upgradeUrl } from "../../../lib/cloudPlan";
import { openExternal } from "../../../lib/openExternal";
import { putAuraComputer } from "../../../lib/useAuraComputer";

export type ComputerBusy = "upgrade" | "start" | "wake" | "retry" | "resize" | null;

/** How long an open payment page keeps the computer being read for. Past it,
 *  coming back to the window reads it again. */
const PAYING_MS = 15 * 60_000;

/** `paying` is the caller's, so the read that follows the payment can be told
 *  to keep going (`useAuraComputer({ waiting: paying })`) before the actions
 *  that set it exist. */
export function useComputerActions(
  status: AuraComputerStatus | null,
  [paying, setPaying]: [boolean, Dispatch<SetStateAction<boolean>>],
) {
  const [busy, setBusy] = useState<ComputerBusy>(null);
  const [failed, setFailed] = useState("");
  const computer = status?.computer ?? null;
  useEffect(() => {
    if (computer && !settingUp(computer)) setPaying(false);
  }, [computer, setPaying]);
  useEffect(() => {
    if (!paying) return;
    const t = setTimeout(() => setPaying(false), PAYING_MS);
    return () => clearTimeout(t);
  }, [paying, setPaying]);

  const run = (what: Exclude<ComputerBusy, null>, call: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(what);
    setFailed("");
    call()
      .catch((e) => setFailed(messageOf(e)))
      .finally(() => setBusy(null));
  };
  const put = (s: AuraComputerStatus) => putAuraComputer(s);

  return {
    busy,
    failed,
    paying,
    upgrade: () =>
      run("upgrade", async () => {
        const plan = upgradePlan(status?.offer ?? null) ?? "pro";
        const origin = cloudOriginsNow().http;
        const url = await billingCheckout(plan, 1, upgradeUrl(origin) ?? origin);
        setPaying(true);
        await openExternal(url);
      }),
    start: () => run("start", () => auraComputerStart().then(put)),
    wake: () => run("wake", () => auraComputerWake().then(put)),
    retry: () => run("retry", () => auraComputerRetry().then(put)),
    resize: (size: string) => run("resize", () => auraComputerResize(size).then(put)),
  };
}
