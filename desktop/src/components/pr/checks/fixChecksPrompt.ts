// Which failing checks GitHub can run again.

import type { PrCheck } from "../../../lib/api";

/** Whether GitHub can re-run this check: it is a GitHub Actions run. */
export function isRerunnable(check: PrCheck): boolean {
  return /\/actions\/runs\/\d+/.test(check.url);
}
