//! The two running totals a per-message cost card needs around it.
//!
//! A message's own price is stamped on the turn when it settles, so the bubble
//! already knows it. The other two numbers people ask for in the same breath —
//! "and what has this chat cost?", "and what have I spent overall?" — are
//! properties of the conversation and of the spend ledger, not of any one
//! turn. They're computed once per chat here and read through a context, so a
//! settled bubble doesn't have to be handed them (and the memoized transcript
//! doesn't repaint every time a total moves).
//!
//! Nothing here prices anything. The per-turn figures were priced ONCE, in
//! `settle_turn_cost`, against the same table that wrote `~/.aura/api-spend.
//! json` — this module only adds up numbers that were already charged, which
//! is why the card and the composer's spend meter cannot drift apart.

import * as React from "react";

import { api, type ChatTurn } from "../../../lib/api";

/** What the conversation and the ledger have cost, for the hover card. */
export type ChatSpend = {
  /** USD this conversation's settled messages have billed. Null when none of
   *  them recorded a cost — a chat driven entirely by a CLI brain never does,
   *  and an absent row is better than a zero. */
  sessionUsd: number | null;
  sessionEstimated: boolean;
  /** Some messages in this chat recorded no cost, so `sessionUsd` is a floor.
   *  True for any chat with history from before turns carried their price. */
  sessionPartial: boolean;
  /** USD across every key in `~/.aura/api-spend.json`, since each was added.
   *  Null when the ledger is empty or unreadable. */
  totalUsd: number | null;
  totalEstimated: boolean;
};

const NO_SPEND: ChatSpend = {
  sessionUsd: null,
  sessionEstimated: false,
  sessionPartial: false,
  totalUsd: null,
  totalEstimated: false,
};

export const ChatSpendContext = React.createContext<ChatSpend>(NO_SPEND);

/** Read the chat's running spend. Defaults to "nothing known", so a surface
 *  rendered outside the provider shows no money rather than wrong ones. */
export function useChatSpend(): ChatSpend {
  return React.useContext(ChatSpendContext);
}

/** A dollar figure that was really recorded. */
function billed(usd: number | null | undefined): number | null {
  return typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : null;
}

/**
 * Add up what this conversation's assistant turns billed.
 *
 * Only turns that carry a cost count. A turn without one isn't treated as free
 * — it's counted as a gap, which is what flips `sessionPartial` and puts a `≥`
 * in front of the figure. Understating and saying so beats a confident wrong
 * number.
 */
export function summarizeSessionSpend(
  chat: ChatTurn[] | undefined,
): Pick<ChatSpend, "sessionUsd" | "sessionEstimated" | "sessionPartial"> {
  let sum = 0;
  let priced = 0;
  let gaps = 0;
  let estimated = false;
  for (const turn of chat ?? []) {
    if (turn.role !== "manager") continue;
    const usd = billed(turn.cost_usd);
    if (usd === null) {
      gaps += 1;
      continue;
    }
    sum += usd;
    priced += 1;
    if (turn.cost_estimated) estimated = true;
  }
  return {
    sessionUsd: priced > 0 ? sum : null,
    sessionEstimated: estimated,
    sessionPartial: priced > 0 && gaps > 0,
  };
}

/**
 * The lifetime total across every API key in the ledger.
 *
 * `refreshKey` re-reads it; the chat passes whatever moves when a turn settles
 * so the card is current the moment you hover the message that just landed. A
 * ledger that won't parse leaves the figure null, because the all-time row is
 * a nicety and a wrong one would poison the whole card.
 */
export function useApiSpendTotal(refreshKey: unknown): {
  totalUsd: number | null;
  totalEstimated: boolean;
} {
  const [total, setTotal] = React.useState<{
    totalUsd: number | null;
    totalEstimated: boolean;
  }>({ totalUsd: null, totalEstimated: false });

  React.useEffect(() => {
    let alive = true;
    void api
      .brainApiSpend()
      .then((rows) => {
        if (!alive) return;
        const usable = rows.filter((r) => Number.isFinite(r.costUsd));
        setTotal({
          totalUsd:
            usable.length > 0
              ? usable.reduce((acc, r) => acc + r.costUsd, 0)
              : null,
          totalEstimated: usable.some((r) => r.estimated),
        });
      })
      .catch(() => {
        if (alive) setTotal({ totalUsd: null, totalEstimated: false });
      });
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  return total;
}

/** Everything the cost card needs about the chat around a message. */
export function useChatSpendValue(
  chat: ChatTurn[] | undefined,
  refreshKey: unknown,
): ChatSpend {
  const session = React.useMemo(() => summarizeSessionSpend(chat), [chat]);
  const total = useApiSpendTotal(refreshKey);
  return React.useMemo(
    () => ({ ...session, ...total }),
    [session, total],
  );
}

/**
 * How a turn was paid for, from the brain that ran it.
 *
 * Only claims `"subscription"` where the id says so outright — a CLI wrapper
 * drives an agent CLI signed into the user's own plan, which is genuinely not
 * billed per token, and telling them that is a real answer rather than a
 * blank. Everything else returns null so the card falls back to the honest
 * "no price recorded" instead of asserting a billing model we're guessing at.
 */
export function billingForBrain(brainId: string | null | undefined): "subscription" | null {
  const id = (brainId ?? "").trim().toLowerCase();
  if (!id) return null;
  return id.startsWith("cli_wrapper:") || id.startsWith("cli:") ? "subscription" : null;
}
