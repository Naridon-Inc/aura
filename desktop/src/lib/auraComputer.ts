// The computer Aura runs for a team: what the plan includes, its progress,
// its size, and waking it. It comes with Pro and Teams — nothing is bought on
// its own. Each call is one Tauri command (cmd_aura_computer.rs) over the
// signed-in token; the server writes every sentence a person reads about the
// computer (`headline`, `problem`, `hours_line`, the offer's `reason`,
// `summary` and each size's `price_line` and `fits_line`), so what is left
// here is choosing which of them to show.

import { invoke } from "@tauri-apps/api/core";

/** One size the computer can run at. Standard comes with the plan; the
 *  bigger ones are a monthly line on the Teams subscription. */
export type AuraComputerSize = {
  instance_type: string;
  name: string;
  /** "Large · 8 cores · 32 GB". */
  label: string;
  cores: number;
  memory_gb: number;
  disk_gb: number;
  /** Null: the plan includes it. */
  price_usd: number | null;
  /** "Included with your plan" or "$129 a month". */
  price_line: string;
  fits: string;
  /** "Fits about 5 people working at once." */
  fits_line: string;
  month_hours: number;
  available: boolean;
  /** Why it can't be picked, in a sentence. */
  reason: string | null;
};

/** What the org's plan gives it, from `GET /computers`. */
export type AuraComputerOffer = {
  /** The org has a computer, or its plan gives it one. */
  available: boolean;
  /** Why not, in a sentence, when it doesn't. */
  reason: string | null;
  /** The plan includes a computer. Older servers leave it out. */
  included?: boolean;
  /** The plan to move to for one, when this one has none. */
  upgrade_to?: "pro" | "team" | null;
  /** Kept false by servers where the computer comes with the plan. */
  can_buy: boolean;
  /** An admin of a paying org with no computer yet may start it now. Servers
   *  that start it by themselves when anyone looks only set this when that
   *  didn't work, so the button is a way to try again. */
  can_start?: boolean;
  /** Why the plan's computer didn't start by itself ("The computer starts
   *  when your trial ends…"). Older servers leave it out. */
  start_problem?: string | null;
  /** An admin may change its size. */
  can_change_size?: boolean;
  price_usd: number;
  interval: string;
  fair_use_hours: number;
  /** Awake hours after which it rests until the 1st of next month. Older servers leave it out. */
  month_hours?: number;
  idle_minutes: number;
  grace_days: number;
  sizes?: AuraComputerSize[];
  /** For anything bigger than the biggest size: "Talk to us". */
  larger?: string;
  summary: string;
};

export type AuraComputerStage =
  | "paying"
  | "launching"
  | "installing"
  | "joining"
  | "ready"
  | "asleep"
  | "waking"
  | "stopping"
  | "ending"
  | "ended"
  | "failed";

export type AuraComputer = {
  id: string;
  name: string;
  stage: AuraComputerStage;
  /** The server's one line for the stage: "Waking the computer…". */
  headline: string;
  /** What went wrong, in a sentence, when something did. */
  problem: string | null;
  progress_step: number | null;
  progress_of: number | null;
  /** `awaiting_payment` | `active` | `past_due` | `canceled`. */
  billing: string;
  /** When a computer whose payment stopped is ended for good. */
  ends_at: string | null;
  awake_hours_this_month: number;
  hours_left_this_month?: number;
  /** "12 of 60 awake hours used this month · 48 left". */
  hours_line?: string;
  fair_use_hours: number;
  /** Awake hours after which it rests until the 1st of next month. */
  month_hours?: number;
  /** The size the org pays for (an instance type). */
  size?: string;
  /** "Large · 8 cores · 32 GB". */
  size_label?: string;
  /** The size the machine is now, when a new one waits for its next wake. */
  running_size_label?: string | null;
  /** "Becomes Large the next time it wakes up." */
  size_note?: string | null;
  /** Bought on its own before plans included one. */
  bought_alone?: boolean;
  /** The month's hours are used up: it rests, and doesn't wake, until this moment. */
  rests_until?: string | null;
  sleeps_after_minutes: number;
  place_id: string | null;
  instance_id: string | null;
  region: string | null;
  can_wake: boolean;
  can_retry: boolean;
  since: string;
};

export type AuraComputerStatus = {
  /** Null when this server doesn't offer computers at all. */
  offer: AuraComputerOffer | null;
  /** The team's computer, from the moment somebody started buying it. */
  computer: AuraComputer | null;
  /** The last one that ended, when the team has none now. */
  ended: AuraComputer | null;
};

export const auraComputerStatus = () => invoke<AuraComputerStatus>("aura_computer_status");

/** Start the computer the plan includes, for an org that paid before plans
 *  came with one. */
export const auraComputerStart = () => invoke<AuraComputerStatus>("aura_computer_start");

/** Change its size. The bill changes now, the machine at its next wake. */
export const auraComputerResize = (size: string) => invoke<AuraComputerStatus>("aura_computer_resize", { size });

export const auraComputerWake = () => invoke<AuraComputerStatus>("aura_computer_wake");

export const auraComputerRetry = () => invoke<AuraComputerStatus>("aura_computer_retry");

/** The stages a new computer passes through before it can answer anything. */
const SETTING_UP: ReadonlySet<AuraComputerStage> = new Set(["paying", "launching", "installing", "joining"]);

export function settingUp(c: Pick<AuraComputer, "stage"> | null | undefined): boolean {
  return !!c && SETTING_UP.has(c.stage);
}

/** Asleep, or on its way to sleep or back from it. It still answers chats —
 *  the first one just waits for it to boot — unless it is resting until the
 *  1st, which its `problem` says. */
export function dozing(c: Pick<AuraComputer, "stage"> | null | undefined): boolean {
  return !!c && (c.stage === "asleep" || c.stage === "stopping" || c.stage === "waking");
}


/** How far through setting up it is, as a fraction for a progress bar. */
export function progressOf(c: Pick<AuraComputer, "progress_step" | "progress_of">): number | null {
  const step = c.progress_step ?? null;
  const of = c.progress_of ?? null;
  if (step === null || of === null || of <= 0) return null;
  return Math.min(1, Math.max(0, step / of));
}

/** "Step 3 of 5". */
export function stepLine(c: Pick<AuraComputer, "progress_step" | "progress_of">): string | null {
  return progressOf(c) === null ? null : `Step ${c.progress_step} of ${c.progress_of}`;
}

/** "12 of 60 awake hours used this month · 48 left", and what happens past
 *  them. The server's line when it sends one. */
export function usageLine(
  c: Pick<AuraComputer, "awake_hours_this_month" | "fair_use_hours" | "sleeps_after_minutes"> &
    Partial<Pick<AuraComputer, "month_hours" | "rests_until" | "hours_line">>,
): string {
  if (c.hours_line) return c.hours_line;
  const used = Math.round(c.awake_hours_this_month * 10) / 10;
  if (c.rests_until && c.month_hours) return `All ${c.month_hours} awake hours used this month.`;
  const base = `${used} of ${c.fair_use_hours} awake hours used this month`;
  if (used < c.fair_use_hours) return `${base}.`;
  const rest = c.month_hours ? ` At ${c.month_hours} it rests until the 1st.` : "";
  return `${base}. It now sleeps after ${c.sleeps_after_minutes} minutes with nothing to do.${rest}`;
}

/** When a computer whose payment stopped is ended for good, as a sentence. */
export function endsLine(c: Pick<AuraComputer, "ends_at">, now = Date.now()): string | null {
  if (!c.ends_at) return null;
  const at = Date.parse(c.ends_at);
  if (!Number.isFinite(at)) return null;
  const days = Math.ceil((at - now) / 86_400_000);
  if (days <= 0) return "Its payment stopped, so it is being ended.";
  return `Its payment stopped. Pay again within ${days} ${days === 1 ? "day" : "days"} to keep it and everything on it.`;
}

/** Its payment stopped — Stripe gave up on it, or it was cancelled — so it
 *  wakes for nobody until somebody pays again. A failed payment Stripe is
 *  still retrying keeps it working, so that one isn't this. */
export function paymentStopped(c: Pick<AuraComputer, "billing"> | null | undefined): boolean {
  return c?.billing === "unpaid" || c?.billing === "canceled";
}

/** The team's computer, when it is the one behind the place `placeId` and
 *  its payment stopped: the work sent there waits on a payment. */
export function stoppedComputerAt(
  status: Pick<AuraComputerStatus, "computer"> | null | undefined,
  placeId: string | null | undefined,
): AuraComputer | null {
  const c = status?.computer;
  if (!c || !placeId || c.place_id !== placeId || !paymentStopped(c)) return null;
  return c;
}

/** Opens Settings → Billing, where the plan is paid for again. */
export function openPlanBilling(): void {
  window.dispatchEvent(new CustomEvent("aura:open-settings", { detail: { pane: "billing" } }));
}

/** Why the org has no computer, or null when it has one or its plan gives
 *  it one. */
export function offerRefusal(offer: AuraComputerOffer | null): string | null {
  if (!offer) return "Aura Cloud doesn't offer computers yet.";
  if (!offer.available) return offer.reason || "A cloud computer comes with Pro or Teams.";
  return offer.start_problem || null;
}

/** Whether to offer a Start button: only when starting by itself didn't
 *  happen and nothing says why. A reason is shown instead of a button that
 *  would only say it again. */
export function offerStartButton(offer: AuraComputerOffer | null): boolean {
  return !!offer?.can_start && !offer.start_problem;
}

/** The plan to check out for a computer, when the org's plan has none. */
export function upgradePlan(offer: AuraComputerOffer | null): "pro" | "team" | null {
  if (!offer || offer.included !== false) return null;
  return offer.upgrade_to === "team" ? "team" : "pro";
}

/** The button that moves the org to that plan. */
export function upgradeLabel(plan: "pro" | "team"): string {
  return plan === "team" ? "Upgrade to Teams" : "Upgrade to Pro";
}

/** "Large · 8 cores · 32 GB", and the size it waits to become. */
export function sizeLine(c: Pick<AuraComputer, "size_label" | "size_note">): string | null {
  if (!c.size_label) return null;
  return c.size_note ? `${c.size_label}. ${c.size_note}` : c.size_label;
}

/** Something is changing on the computer: a reason to read it again soon.
 *  A settled computer is read once. */
export function moving(c: Pick<AuraComputer, "stage"> | null | undefined): boolean {
  return settingUp(c) || c?.stage === "waking" || c?.stage === "stopping";
}

/** A prompt the server marked as having woken the computer is still waiting
 *  on the boot while the computer has not come back: the line says "Waking
 *  the computer…" rather than that somebody is working on it. */
export function stillWaking(
  prompt: { waking?: boolean | null } | null | undefined,
  computer: Pick<AuraComputer, "stage"> | null | undefined,
): boolean {
  if (!prompt?.waking) return false;
  // Before the first status read there is nothing better than the server's
  // word at send time.
  if (computer === undefined) return true;
  return !!computer && dozing(computer);
}
