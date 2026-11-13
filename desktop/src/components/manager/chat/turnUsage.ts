import type { TurnUsageRow } from "../../ui/transcript-patterns";
import { formatCost } from "../../../lib/money";
import type { TurnCost, TurnMoneyRow } from "../../../lib/turnCost";

/** `~` for a family-rate estimate, `≥` for a total known to be incomplete. */
function amount(row: TurnMoneyRow): string {
  return `${row.atLeast ? "≥" : ""}${row.estimated ? "~" : ""}${formatCost(row.usd)}`;
}

/** A turn's cost as the rows of its usage card: which model ran it, the
 *  token counts the engine reported, then what it cost — this message, this
 *  chat, all time — only the figures we were actually told. When the message
 *  has no price of its own the reason is the card's note, so a reply that ran
 *  on a plan says so instead of showing a blank. */
export function turnUsage(cost: TurnCost): { usage: TurnUsageRow[]; usageNote?: string } {
  const usage: TurnUsageRow[] = [];
  if (cost.title) usage.push({ label: "Model", value: cost.title });
  for (const row of cost.rows) {
    usage.push({ label: row.label, value: row.value.toLocaleString() });
  }
  for (const row of cost.money) {
    usage.push({ label: row.label, value: amount(row), hint: row.hint });
  }
  return { usage, usageNote: cost.unpriced ?? undefined };
}
