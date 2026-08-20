// One ladder for printing a dollar amount.
//
// Eight places printed one, under four different rules, and they disagreed
// about the two things that matter with money: how many decimals, and what
// a very small amount looks like.
// The same turn cost read "$0.003" in the normalized transcript and "$0.00"
// in the other one — the second saying a turn you paid for was free. Team
// settings and the manager's usage roll-up printed the same member's spend
// two different ways. Nothing had a rung above a thousand, so a big team
// month came out as "$3400.0k" in one place and "$3400000.00" in another.
//
// The rule below is the one most of those eight already used, so almost
// nothing on screen changed shape. Two decisions were made once, here:
//
//   • Under a cent, print four decimals. "$0.00" for a real cost is a lie,
//     and per-turn costs live down here.
//   • Above a thousand, hand off to the compactNumber ladder, so a month's
//     spend reads "$3.4k" and a year's reads "$4.1M".
//
//   0 → "$0"        0.0042 → "$0.0042"    0.05 → "$0.05"
//   1.2 → "$1.20"   3400 → "$3.4k"        3.4e6 → "$3.4M"

import { compactNumber } from "./compactNumber";

/** USD for display. Non-finite input reads as "$0" rather than "$NaN". */
export function formatCost(usd: number): string {
  const v = Number.isFinite(usd) ? usd : 0;
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs === 0) return "$0";
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  if (abs < 1000) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${compactNumber(abs)}`;
}
