//! The "API spend" section of the usage popover — what a turn cost, and what
//! the key has cost since it was added.
//!
//!   API spend
//!   This response                                $0.0042
//!   Since 12 Jul · all projects                    $1.87
//!
//! Only ever shown in API mode. A subscription or CLI-wrapper brain isn't
//! billed per token, so there is no honest number to print and the section
//! doesn't render at all.
//!
//! The running total deliberately spans EVERY project, because that's the
//! question a key raises — not "what did this checkout spend" but "what is
//! this key costing me". The date is the day the key was added: swap the key
//! and the total starts again from zero, which is the only reading of "since
//! the key was added" that stays true.
//!
//! `estimated` marks a figure priced off a model-family rate rather than a
//! published one — a model that shipped after this build still gets a number,
//! and the `~` says out loud that it's a ballpark.

import { Rule, SectionHead, StatRow } from "./usageAtoms";
import { formatCost } from "../../../lib/money";
import type { TurnSpend } from "./types";

/** "12 Jul" / "12 Jul 2025" — the year only once it stops being this one, so
 *  the common case stays short. */
function shortDate(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Prefix an estimated figure with `~`. */
function money(usd: number, estimated: boolean): string {
  return `${estimated ? "~" : ""}${formatCost(usd)}`;
}

export function UsageSpendSection({ spend }: { spend: TurnSpend | null }) {
  if (!spend) return null;
  const since = shortDate(spend.spendSince);
  return (
    <>
      <Rule />
      <SectionHead title="API spend" />
      <div className="mt-2.5 flex flex-col gap-1.5">
        <StatRow
          label="This response"
          value={money(spend.costUsd, spend.estimated)}
          strong
        />
        <StatRow
          label={since ? `Since ${since} · all projects` : "All projects"}
          value={money(spend.spendUsd, spend.estimated)}
        />
      </div>
    </>
  );
}
