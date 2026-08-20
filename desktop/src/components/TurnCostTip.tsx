// The elapsed time on a turn, turned into a handle.
//
// One card, two very different transcripts: the coding-agent renderer (Claude,
// Codex, Gemini, Cursor — anything that maps into the normalized events) and
// Aura's own chat. Both show a turn's elapsed time; both were mute about what
// that time bought.
//
// It answers in money first — what this message cost, what the chat has cost,
// what every key has cost since it was added — because that is the question
// people are actually asking when they hover. The model, the window and the
// token counts sit below as the working behind the figure. It stays a tooltip:
// three short money lines and three lines of detail, not a dashboard.
//
// Silent about whatever the engine didn't report, and explicit about WHY when
// there is no price — an unpriced model, an unmetered subscription and a turn
// nobody counted are three different situations and each is said in words. No
// branch of this file can print $0.00 for a message that was billed.

import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { formatCost } from "../lib/money";
import { hasTurnCost, type TurnCost, type TurnMoneyRow } from "../lib/turnCost";

/** `~` for a family-rate estimate, `≥` for a total we know is incomplete. */
function amount(row: TurnMoneyRow): string {
  return `${row.atLeast ? "≥" : ""}${row.estimated ? "~" : ""}${formatCost(row.usd)}`;
}

/** The card's body. Exported so a surface can render it somewhere other than
 *  a tooltip without rebuilding the layout. */
export function TurnCostBody({ cost }: { cost: TurnCost }) {
  const detail = cost.title || cost.range || cost.rows.length > 0;
  return (
    <div className="min-w-[218px] max-w-[264px] text-left">
      {/* Whether it's a figure or a sentence, the top line always answers the
          same question: what did THIS message cost. The note stands exactly
          where the number would have been rather than trailing the totals,
          so the absence is as legible as a price would have been. */}
      {cost.unpriced && (
        <div
          className={`text-2xs leading-snug text-text-4 ${
            cost.money.length > 0 ? "mb-1.5" : ""
          }`}
        >
          {cost.unpriced}
        </div>
      )}
      {cost.money.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {cost.money.map((row) => (
            <div
              key={row.label}
              className="flex items-baseline justify-between gap-8 text-xs"
              title={row.hint}
            >
              <span className="text-text-4">{row.label}</span>
              <span
                className="tabular-nums"
                style={{
                  // The message's own cost is the one number this card exists
                  // for, so it carries Aura's green; the running totals stay
                  // ordinary ink and read as context around it.
                  color: row.lead
                    ? "var(--color-accent-green)"
                    : "var(--color-text-2)",
                  fontWeight: row.lead ? 600 : 400,
                }}
              >
                {amount(row)}
              </span>
            </div>
          ))}
        </div>
      )}
      {detail && (cost.money.length > 0 || cost.unpriced) && (
        <div
          className="my-2 h-px"
          style={{ background: "var(--color-line-soft)" }}
          aria-hidden
        />
      )}
      {cost.title && (
        <div className="text-xs font-medium text-text-1">{cost.title}</div>
      )}
      {cost.range && (
        <div className="mt-0.5 text-2xs text-text-4">{cost.range}</div>
      )}
      {cost.rows.length > 0 && (
        <div className="mt-1 text-2xs text-text-4">
          {cost.rows.map((r, i) => (
            <span key={r.label}>
              {i > 0 && <span className="opacity-60"> · </span>}
              {r.label}{" "}
              <span className="tabular-nums text-text-3">
                {r.value.toLocaleString()}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Wrap a turn's elapsed time so hovering it opens the cost.
 *
 * When the engine told us nothing, the child is returned untouched — a hover
 * that opens an empty card is worse than a hover that does nothing.
 */
export function TurnCostTip({
  cost,
  children,
}: {
  cost: TurnCost;
  children: ReactNode;
}) {
  if (!hasTurnCost(cost)) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">
        <TurnCostBody cost={cost} />
      </TooltipContent>
    </Tooltip>
  );
}
