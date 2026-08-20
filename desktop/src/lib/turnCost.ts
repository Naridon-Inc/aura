// What a turn actually cost, in the shape a person reads it.
//
// Elapsed time is the number everyone looks at and the least informative on
// its own: three minutes of thinking and three minutes of re-reading the same
// context look identical and cost nothing alike. So the time becomes the
// handle — hover it and the turn opens into what it cost, what the
// conversation has cost, what every key has cost, and the tokens behind it.
//
// Money leads because money is the question. Tokens stay, one line down, as
// the working that explains the figure.
//
// Every field is optional because every engine reports a different subset: a
// CLI wrapper may give tokens and no model, the native brain gives a model and
// no cache planes. Nothing here invents a figure. A number we were not told is
// a row that isn't drawn — never a zero standing in for "unknown", because a
// zero on a money surface reads as "this was free" and that is a lie.

export type TurnCostInput = {
  /** The model that ran, as the engine named it. */
  model?: string | null;
  /** What it ran through — the agent CLI or the brain. */
  agent?: string | null;
  startMs?: number | null;
  endMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  /** USD this one message billed, as recorded when the turn settled. */
  costUsd?: number | null;
  /** That figure came off a model-family rate, not a published one. */
  costEstimated?: boolean | null;
  /** USD every settled message in this conversation has billed so far. */
  sessionCostUsd?: number | null;
  sessionEstimated?: boolean | null;
  /** True when some messages in the conversation recorded no cost, so the
   *  session figure is a floor rather than the whole bill. */
  sessionPartial?: boolean | null;
  /** This engine reports cost for the whole RUN and never per message — an
   *  agent CLI's `total_cost_usd`. Changes what the card can honestly claim
   *  about the message in front of you, so it is stated, never guessed. */
  sessionIsRunTotal?: boolean | null;
  /** USD across the whole spend ledger — every API key, every project, since
   *  each key was added. The "what is this costing me overall" number. */
  totalCostUsd?: number | null;
  totalEstimated?: boolean | null;
  /** How this turn was paid for. `"subscription"` means a CLI brain running
   *  on a plan, which is not billed per token at all — a blank there is the
   *  right answer and deserves saying out loud rather than looking broken. */
  billing?: TurnBilling | null;
};

export type TurnBilling = "api" | "subscription";

export type TurnCostRow = { label: string; value: number };

/** One money line. `atLeast` marks a figure we know is incomplete, printed
 *  with a `≥` so it never reads as the whole bill. */
export type TurnMoneyRow = {
  label: string;
  usd: number;
  estimated: boolean;
  atLeast?: boolean;
  /** The headline — this message's own cost. */
  lead?: boolean;
  /** Plain-language expansion, shown as the row's title attribute. */
  hint?: string;
};

export type TurnCost = {
  /** "Opus 5 via Claude Code", or whichever half we were told. */
  title: string | null;
  /** "Aug 1, 2026, 10:47 PM → Aug 2, 2026, 2:10 AM". */
  range: string | null;
  rows: TurnCostRow[];
  /** This message, this session, all time — in that order, and only the ones
   *  we were actually told. */
  money: TurnMoneyRow[];
  /** Why this message carries no price of its own, in plain language. Null
   *  when it has one. */
  unpriced: string | null;
};

function clean(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : null;
}

/** A count we can show: told to us, finite, and worth a row. */
function counted(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** A dollar figure we were actually given. Zero counts — a key that has spent
 *  nothing really has spent nothing — but `null`, `undefined` and NaN do not. */
function money(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Who ran this turn.
 *
 * Both halves matter and neither is guaranteed: the model is the thing you're
 * paying for, the agent is the thing you launched. When they're the same word
 * — an engine that reports its own name as the model — saying it twice reads
 * as a bug, so it's said once.
 */
export function turnCostTitle(
  model?: string | null,
  agent?: string | null,
): string | null {
  const m = clean(model);
  const a = clean(agent);
  if (m && a) return m.toLowerCase() === a.toLowerCase() ? m : `${m} via ${a}`;
  return m ?? a;
}

function stamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Just the clock, for the far end of a range that starts the same day. */
function clockStamp(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Same calendar day, in the reader's own timezone. */
function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

function moment(ms: number | null | undefined): number | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * The window the turn occupied.
 *
 * A single known end is still worth showing, since "when did this land" is a
 * real question on its own, so a missing start narrows the answer rather than
 * withholding it.
 *
 * Two things this refuses to print, both of which read as a broken card rather
 * than as information:
 *
 *  - **The same instant twice.** Most turns finish inside a minute, and at
 *    minute resolution that made the common case render as
 *    "Jul 25, 2026 at 8:41 PM → Jul 25, 2026 at 8:41 PM": two identical halves,
 *    an arrow between them, wrapped over two lines of a tooltip. One stamp says
 *    the same thing and looks deliberate.
 *  - **The date twice in one day.** A turn that starts and ends on the same day
 *    only needs the clock at the far end, which also keeps the line short
 *    enough not to wrap.
 */
export function turnCostRange(
  startMs?: number | null,
  endMs?: number | null,
): string | null {
  const start = moment(startMs);
  const end = moment(endMs);
  if (start && end) {
    const from = stamp(start);
    const to = sameDay(start, end) ? clockStamp(end) : stamp(end);
    // Compared after formatting, not before: the card's resolution is the
    // minute, so two timestamps 900ms apart are the same moment as far as
    // anything on screen is concerned.
    if (from === stamp(end) || from.endsWith(to)) return from;
    return `${from} → ${to}`;
  }
  if (end) return stamp(end);
  if (start) return stamp(start);
  return null;
}

/**
 * Say, in words, why this message has no price on it.
 *
 * Each branch names a different real situation, because "no number" has
 * several causes and they call for different reactions from the reader: an
 * engine that only totals the run was never going to itemise, a subscription
 * turn is *supposed* to be blank, an unpriced model is one line in
 * `~/.aura/model_prices.json` away from a figure, and a turn nobody counted
 * can't be recovered at all. Collapsing them into one shrug would hide the
 * one the user can actually act on.
 */
function unpricedReason(input: TurnCostInput, model: string | null): string {
  const anyTokens =
    counted(input.inputTokens) !== null || counted(input.outputTokens) !== null;
  // An engine that only ever totals the run was never going to itemise. That's
  // the reason, so it goes first — but only once it has told us something,
  // since an engine that reported nothing at all is a plainer story.
  if (input.sessionIsRunTotal && (anyTokens || money(input.sessionCostUsd) !== null)) {
    return "This engine bills the run, not each message.";
  }
  if (input.billing === "subscription") {
    return "Runs on your plan. This message isn't billed per token.";
  }
  if (!anyTokens) return "The engine reported no token counts for this message.";
  // Naming the model is the point: it turns a dead end into one line in
  // ~/.aura/model_prices.json, which is a thing the reader can go and do.
  if (model) return `No price on file for ${model}.`;
  return "No price was recorded for this message.";
}

export function buildTurnCost(input: TurnCostInput): TurnCost {
  const rows: TurnCostRow[] = [];
  const push = (label: string, n: number | null | undefined) => {
    const v = counted(n);
    if (v !== null) rows.push({ label, value: v });
  };
  // Ordered the way the money reads: what went in, what came back, then the
  // cache planes that explain why a huge input was cheap.
  push("Input", input.inputTokens);
  push("Output", input.outputTokens);
  // The cache planes are shown as counts and left out of every dollar figure.
  // The rate table carries no cache rates, and the ledger bills none, so
  // pricing them here would invent a number AND put this card at odds with
  // the spend meter over the same turn. Two wrongs.
  push("Cache read", input.cacheRead);
  push("Cache write", input.cacheWrite);

  const model = clean(input.model);
  const turn = money(input.costUsd);
  const session = money(input.sessionCostUsd);
  const total = money(input.totalCostUsd);

  const moneyRows: TurnMoneyRow[] = [];
  if (turn !== null) {
    moneyRows.push({
      label: "This message",
      usd: turn,
      estimated: input.costEstimated === true,
      lead: true,
      hint: "Every API call this message made, at the model's rate.",
    });
  }
  if (session !== null) {
    const runTotal = input.sessionIsRunTotal === true;
    moneyRows.push({
      label: runTotal ? "This run" : "This chat",
      usd: session,
      estimated: input.sessionEstimated === true,
      atLeast: input.sessionPartial === true,
      hint: runTotal
        ? "What the agent reports for this run so far."
        : input.sessionPartial === true
          ? "At least this much. Some earlier messages in this chat recorded no cost."
          : "Every message in this conversation, added up.",
    });
  }
  if (total !== null) {
    moneyRows.push({
      label: "All time",
      usd: total,
      estimated: input.totalEstimated === true,
      hint: "Every API key, every project, since each key was added.",
    });
  }

  return {
    title: turnCostTitle(model, input.agent),
    range: turnCostRange(input.startMs, input.endMs),
    rows,
    money: moneyRows,
    unpriced: turn === null ? unpricedReason(input, model) : null,
  };
}

/** Is there anything to show? A card with nothing in it is worse than none. */
export function hasTurnCost(cost: TurnCost): boolean {
  return (
    cost.title !== null ||
    cost.range !== null ||
    cost.rows.length > 0 ||
    cost.money.length > 0
  );
}
