// What the account row is allowed to say about who you are and which plan
// you're on — only what the cloud actually told us. A plan we weren't told is
// a word we don't print, and signed out says signed out rather than guessing
// "Free".

/** What the chip is able to say, from what we were actually told. */
export type AccountStanding = {
  signedIn: boolean;
  /** The account handle, when the cloud named one. */
  user: string | null;
  /** The plan word, when a billing read succeeded. Never inferred. */
  tier: string | null;
};

/** Title-case a plan the cloud spells however it likes (`free`, `PRO`). */
function planWord(tier: string | null): string | null {
  const t = (tier ?? "").trim();
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** `@`-prefixed, exactly once, however it was stored. */
function atHandle(user: string | null): string | null {
  const u = (user ?? "").trim().replace(/^@/, "");
  return u ? `@${u}` : null;
}

/**
 * The plan badge, or nothing.
 *
 * Only a plan we were actually told goes in the badge. Printing "Free" at
 * someone whose plan we couldn't read tells them they're on a plan they may
 * not have — and the person it misleads most is the one paying for a bigger
 * one.
 */
export function standingPlan(s: AccountStanding): string | null {
  return s.signedIn ? planWord(s.tier) : null;
}

/**
 * The name beside the badge — whose plan this is.
 *
 * Signed out is an ask, not a state, so it says so rather than leaving the
 * bottom edge blank. Signed in with no name to show still beats silence,
 * because a badge on its own doesn't say whose account it belongs to.
 */
export function standingWho(s: AccountStanding): string {
  if (!s.signedIn) return "Sign in";
  return atHandle(s.user) ?? "Signed in";
}

/** The chip's hover text — the long form of what the two words compress. */
export function standingTitle(
  s: AccountStanding,
  trialDays: number | null,
): string {
  if (!s.signedIn) return "Sign in to Aura’s cloud";
  const plan = standingPlan(s);
  const who = standingWho(s);
  if (!plan) return `${who}, your account`;
  // A trial is the one case where the plan you can use isn't the plan you're
  // subscribed to, and how many days are left is the whole point of saying so.
  const trial =
    trialDays && trialDays > 0
      ? ` · trial, ${trialDays} day${trialDays === 1 ? "" : "s"} left`
      : "";
  return `${who} · ${plan} plan${trial}`;
}
