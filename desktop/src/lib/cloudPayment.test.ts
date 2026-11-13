// The claim under test: the payment notice is shown exactly when the cloud
// reports a failed payment, with the cloud's own sentence, and never from a
// half-read answer.

import { describe, expect, it } from "bun:test";

import { paymentNoticeOf } from "./cloudPayment";

describe("paymentNoticeOf", () => {
  it("says nothing when payments are fine or the cloud predates the field", () => {
    expect(paymentNoticeOf({ plan: "team" })).toBeNull();
    expect(paymentNoticeOf({ plan: "team", payment: null })).toBeNull();
    expect(paymentNoticeOf(null)).toBeNull();
  });

  it("keeps the plan and the deadline while the card is retried", () => {
    const notice = paymentNoticeOf({
      payment: {
        state: "past_due",
        paused: false,
        grace_ends_at: "2027-01-29T08:00:00Z",
        action: "update_payment_method",
        message: "Your last payment didn't go through. Update your payment method by January 29 to keep Team.",
      },
    });
    expect(notice).toEqual({
      state: "past_due",
      paused: false,
      graceEndsAt: "2027-01-29T08:00:00Z",
      message: "Your last payment didn't go through. Update your payment method by January 29 to keep Team.",
    });
  });

  it("reads unpaid as paused even if the flag is missing", () => {
    const notice = paymentNoticeOf({ payment: { state: "unpaid", grace_ends_at: "2027-01-29T08:00:00Z" } });
    expect(notice?.paused).toBe(true);
    expect(notice?.graceEndsAt).toBeNull();
    expect(notice?.message).toContain("paused");
  });

  it("ignores a state it does not know", () => {
    expect(paymentNoticeOf({ payment: { state: "something_new", message: "?" } as never })).toBeNull();
  });
});
