// A failed payment, as the cloud's billing status reports it.
//
// The server decides everything here (aura-cloud `billing_lifecycle`): whether
// the plan is still kept, until when, and the sentence to show. This only
// checks the shape, so a cloud older or newer than the app degrades to "no
// notice" instead of rendering half of one.

import type { CloudBillingStatus } from "./api";

export interface PaymentNotice {
  /** `past_due` while the card is being retried; `unpaid` once it stopped. */
  state: "past_due" | "unpaid";
  /** Paid features are off until the payment goes through. */
  paused: boolean;
  /** When the plan stops, while it is still kept. */
  graceEndsAt: string | null;
  /** One sentence for the billing view. */
  message: string;
}

const FALLBACK = {
  grace: "Your last payment didn't go through. Update your payment method to keep your plan.",
  paused:
    "Your payment is overdue, so paid features are paused. Your work is all still here; update your payment method to turn them back on.",
};

export function paymentNoticeOf(billing: CloudBillingStatus | null | undefined): PaymentNotice | null {
  const payment = billing?.payment;
  if (!payment || (payment.state !== "past_due" && payment.state !== "unpaid")) return null;
  const paused = payment.state === "unpaid" || payment.paused === true;
  const message = typeof payment.message === "string" && payment.message.trim() ? payment.message.trim() : null;
  return {
    state: payment.state,
    paused,
    graceEndsAt: !paused && typeof payment.grace_ends_at === "string" ? payment.grace_ends_at : null,
    message: message ?? (paused ? FALLBACK.paused : FALLBACK.grace),
  };
}
