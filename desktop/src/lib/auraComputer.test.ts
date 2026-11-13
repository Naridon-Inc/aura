import {
  dozing,
  endsLine,
  moving,
  offerRefusal,
  offerStartButton,
  paymentStopped,
  progressOf,
  settingUp,
  sizeLine,
  stepLine,
  stillWaking,
  stoppedComputerAt,
  upgradeLabel,
  upgradePlan,
  usageLine,
  type AuraComputer,
  type AuraComputerOffer,
} from "./auraComputer";
import { GLANCING_MS, pollEvery, WATCHING_MS } from "./useAuraComputer";

const offer: AuraComputerOffer = {
  available: true,
  reason: null,
  included: true,
  upgrade_to: null,
  can_buy: false,
  can_start: false,
  can_change_size: false,
  price_usd: 10,
  interval: "month",
  fair_use_hours: 50,
  month_hours: 60,
  idle_minutes: 30,
  grace_days: 7,
  summary: "A computer in the cloud…",
};

describe("the plan's computer", () => {
  test("a plan that includes one has nothing to refuse", () => {
    expect(offerRefusal(offer)).toBeNull();
    expect(upgradePlan(offer)).toBeNull();
  });

  test("Free and trials are told it comes with Pro or Teams, and offered Pro", () => {
    const free = { ...offer, available: false, included: false, upgrade_to: "pro" as const, reason: "A cloud computer comes with Pro or Teams." };
    expect(offerRefusal(free)).toBe("A cloud computer comes with Pro or Teams.");
    expect(offerRefusal({ ...free, reason: null })).toBe("A cloud computer comes with Pro or Teams.");
    expect(upgradePlan(free)).toBe("pro");
    expect(upgradePlan({ ...free, upgrade_to: "team" })).toBe("team");
    expect(upgradeLabel("pro")).toBe("Upgrade to Pro");
    expect(upgradeLabel("team")).toBe("Upgrade to Teams");
  });

  test("a paying team's computer starts by itself: a reason replaces the Start button", () => {
    const refused = { ...offer, can_start: true, start_problem: "The computer starts when your trial ends and the first payment goes through." };
    expect(offerRefusal(refused)).toBe(refused.start_problem);
    expect(offerStartButton(refused)).toBe(false);
    // Starting by itself didn't happen and nothing says why: the button is a retry.
    expect(offerStartButton({ ...offer, can_start: true })).toBe(true);
    expect(offerStartButton({ ...offer, can_start: true, start_problem: null })).toBe(true);
    expect(offerStartButton(offer)).toBe(false);
    expect(offerStartButton(null)).toBe(false);
  });

  test("an older server that sold it alone offers no upgrade", () => {
    const { included: _, ...old } = offer;
    expect(upgradePlan(old)).toBeNull();
    expect(offerRefusal(null)).toBe("Aura Cloud doesn't offer computers yet.");
    expect(upgradePlan(null)).toBeNull();
  });
});

describe("its size", () => {
  test("the size, and the one it becomes at its next wake", () => {
    expect(sizeLine({ size_label: undefined, size_note: undefined })).toBeNull();
    expect(sizeLine({ size_label: "Standard · 2 cores · 8 GB", size_note: null })).toBe("Standard · 2 cores · 8 GB");
    expect(sizeLine({ size_label: "Large · 8 cores · 32 GB", size_note: "Becomes Large the next time it wakes up." })).toBe(
      "Large · 8 cores · 32 GB. Becomes Large the next time it wakes up.",
    );
  });
});

describe("reading it", () => {
  const status = (stage: "ready" | "asleep" | "launching" | "waking" | "stopping" | null) => ({
    offer,
    ended: null,
    computer: stage === null ? null : ({ stage } as never),
  });

  test("a settled computer is read once, not on a timer", () => {
    expect(pollEvery(null, false, true)).toBeNull();
    expect(pollEvery(status(null), false, false)).toBeNull();
    expect(pollEvery(status("ready"), false, true)).toBeNull();
    expect(pollEvery(status("asleep"), false, false)).toBeNull();
  });

  test("a moving one is read again, quicker for someone watching it", () => {
    for (const stage of ["launching", "waking", "stopping"] as const) {
      expect(moving({ stage })).toBe(true);
      expect(pollEvery(status(stage), false, true)).toBe(WATCHING_MS);
      expect(pollEvery(status(stage), false, false)).toBe(GLANCING_MS);
    }
    expect(moving({ stage: "asleep" })).toBe(false);
  });

  test("an open payment page keeps it read until the computer shows up", () => {
    expect(pollEvery(status(null), true, true)).toBe(WATCHING_MS);
    expect(pollEvery(null, true, false)).toBe(GLANCING_MS);
  });
});

describe("setting it up", () => {
  test("the stages before it answers anything", () => {
    for (const stage of ["paying", "launching", "installing", "joining"] as const) {
      expect(settingUp({ stage })).toBe(true);
    }
    for (const stage of ["ready", "asleep", "failed", "ended"] as const) {
      expect(settingUp({ stage })).toBe(false);
    }
    expect(settingUp(null)).toBe(false);
  });

  test("progress comes only from the server's step count", () => {
    expect(progressOf({ progress_step: 3, progress_of: 5 })).toBeCloseTo(0.6);
    expect(stepLine({ progress_step: 3, progress_of: 5 })).toBe("Step 3 of 5");
    expect(progressOf({ progress_step: null, progress_of: null })).toBeNull();
    expect(stepLine({ progress_step: 2, progress_of: 0 })).toBeNull();
  });
});

describe("its month", () => {
  test("the server's line wins when it sends one", () => {
    expect(
      usageLine({
        awake_hours_this_month: 12,
        fair_use_hours: 50,
        sleeps_after_minutes: 30,
        hours_line: "12 of 60 awake hours used this month · 47 left",
      }),
    ).toBe("12 of 60 awake hours used this month · 47 left");
  });

  test("hours used, and what happens past the fair-use line", () => {
    expect(usageLine({ awake_hours_this_month: 12.34, fair_use_hours: 300, sleeps_after_minutes: 30 })).toBe(
      "12.3 of 300 awake hours used this month.",
    );
    expect(usageLine({ awake_hours_this_month: 301, fair_use_hours: 300, sleeps_after_minutes: 10 })).toBe(
      "301 of 300 awake hours used this month. It now sleeps after 10 minutes with nothing to do.",
    );
    expect(
      usageLine({ awake_hours_this_month: 301, fair_use_hours: 300, month_hours: 360, sleeps_after_minutes: 5 }),
    ).toBe("301 of 300 awake hours used this month. It now sleeps after 5 minutes with nothing to do. At 360 it rests until the 1st.");
  });

  test("a used-up month says so instead of counting", () => {
    expect(
      usageLine({
        awake_hours_this_month: 360,
        fair_use_hours: 300,
        month_hours: 360,
        rests_until: "2026-12-01T00:00:00Z",
        sleeps_after_minutes: 5,
      }),
    ).toBe("All 360 awake hours used this month.");
  });

  test("a lapsed payment counts down the grace", () => {
    const now = Date.parse("2026-11-12T00:00:00Z");
    expect(endsLine({ ends_at: null }, now)).toBeNull();
    expect(endsLine({ ends_at: "2026-11-19T00:00:00Z" }, now)).toBe(
      "Its payment stopped. Pay again within 7 days to keep it and everything on it.",
    );
    expect(endsLine({ ends_at: "2026-11-12T10:00:00Z" }, now)).toContain("within 1 day ");
    expect(endsLine({ ends_at: "2026-11-11T00:00:00Z" }, now)).toBe("Its payment stopped, so it is being ended.");
  });
});

describe("waking it", () => {
  test("asleep, going to sleep and coming back all still answer", () => {
    expect(dozing({ stage: "asleep" })).toBe(true);
    expect(dozing({ stage: "stopping" })).toBe(true);
    expect(dozing({ stage: "waking" })).toBe(true);
    expect(dozing({ stage: "ready" })).toBe(false);
  });

  test("a prompt that woke it says so until the computer is back", () => {
    expect(stillWaking({ waking: true }, undefined)).toBe(true);
    expect(stillWaking({ waking: true }, { stage: "waking" })).toBe(true);
    expect(stillWaking({ waking: true }, { stage: "ready" })).toBe(false);
    expect(stillWaking({ waking: true }, null)).toBe(false);
    expect(stillWaking({ waking: null }, { stage: "asleep" })).toBe(false);
    expect(stillWaking(null, { stage: "asleep" })).toBe(false);
  });
});

describe("a payment that stopped", () => {
  const at = (billing: string, place_id: string | null = "p1") =>
    ({ computer: { billing, place_id } as AuraComputer });

  test("only a payment Stripe gave up on, or a cancelled one, stops it", () => {
    expect(paymentStopped({ billing: "unpaid" })).toBe(true);
    expect(paymentStopped({ billing: "canceled" })).toBe(true);
    expect(paymentStopped({ billing: "active" })).toBe(false);
    expect(paymentStopped({ billing: "past_due" })).toBe(false);
    expect(paymentStopped(null)).toBe(false);
  });

  test("a workspace waits on it only when its place is that computer's", () => {
    expect(stoppedComputerAt(at("unpaid"), "p1")?.billing).toBe("unpaid");
    expect(stoppedComputerAt(at("unpaid"), "p2")).toBeNull();
    expect(stoppedComputerAt(at("unpaid"), null)).toBeNull();
    expect(stoppedComputerAt(at("active"), "p1")).toBeNull();
    expect(stoppedComputerAt({ computer: null }, "p1")).toBeNull();
    expect(stoppedComputerAt(null, "p1")).toBeNull();
  });
});
