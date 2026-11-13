// Run with: bun test src/components/commons/crew/GetComputerWizard.test.tsx
//
// The computer that comes with the plan: what a team without one is shown,
// the sizes it can run at, and the team's computer from its first step on.
// These pin what each state says and offers — and that nothing is priced or
// bought on its own.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AuraComputer, AuraComputerOffer, AuraComputerSize } from "../../../lib/auraComputer";
import { ComputerSizes } from "./ComputerSizes";
import { PlanComputer, TeamComputer } from "./GetComputerWizard";

const offer: AuraComputerOffer = {
  available: true,
  reason: null,
  included: true,
  upgrade_to: null,
  can_buy: false,
  can_start: true,
  can_change_size: false,
  price_usd: 10,
  interval: "month",
  fair_use_hours: 50,
  month_hours: 60,
  idle_minutes: 30,
  grace_days: 7,
  summary: "A computer in the cloud that answers your team's chats with Claude. It comes with Pro and Teams.",
};
const free: AuraComputerOffer = {
  ...offer,
  available: false,
  included: false,
  upgrade_to: "pro",
  can_start: false,
  reason: "A cloud computer comes with Pro or Teams.",
};

const computer = (over: Partial<AuraComputer>): AuraComputer => ({
  id: "c-1",
  name: "Aura computer",
  stage: "ready",
  headline: "Ready. It answers your team's chats.",
  problem: null,
  progress_step: null,
  progress_of: null,
  billing: "active",
  ends_at: null,
  awake_hours_this_month: 4,
  fair_use_hours: 50,
  month_hours: 60,
  sleeps_after_minutes: 30,
  place_id: "p-1",
  instance_id: "i-1",
  region: "eu-central-1",
  can_wake: false,
  can_retry: false,
  since: "2026-11-12T10:00:00Z",
  ...over,
});

const none = () => undefined;
const team = (c: AuraComputer) =>
  renderToStaticMarkup(<TeamComputer computer={c} busy={null} onRetry={none} onWake={none} />);
const plan = (o: AuraComputerOffer | null, paying = false) =>
  renderToStaticMarkup(<PlanComputer offer={o} paying={paying} onConnectInstead={none} />);

describe("before the team has one", () => {
  test("a plan that includes one says what it is, with the plan's hours, and no price or title", () => {
    const html = plan(offer);
    expect(html).toContain("It comes with Pro and Teams.");
    expect(html).toContain("sleeps after 30 minutes");
    expect(html).toContain("Your plan includes about 60 awake hours a month. Past 50 it sleeps sooner");
    expect(html).toContain("sleeps until the 1st");
    expect(html).toContain("Nothing is ever charged on top.");
    expect(html).toContain("their own");
    expect(html).not.toContain("$");
    expect(html).not.toContain("<h1");
  });

  test("Free and trials are told it comes with Pro or Teams, and what Pro includes", () => {
    const html = plan(free);
    expect(html).toContain("A cloud computer comes with Pro or Teams.");
    expect(html).toContain("Pro includes about 60 awake hours a month.");
    expect(html).not.toContain("$");
  });

  test("while the plan's payment page is open it says where to finish", () => {
    expect(plan(free, true)).toContain("Finish paying in your browser.");
  });

  test("a server without computers offers connecting a machine instead", () => {
    const html = plan(null);
    expect(html).toContain("Aura can&#x27;t set one up here yet");
    expect(html).toContain("Connect a machine I already have");
  });
});

describe("the sizes", () => {
  const size = (over: Partial<AuraComputerSize>): AuraComputerSize => ({
    instance_type: "t4g.large",
    name: "Standard",
    label: "Standard · 2 cores · 8 GB",
    cores: 2,
    memory_gb: 8,
    disk_gb: 40,
    price_usd: null,
    price_line: "Included with your plan",
    fits: "1–2",
    fits_line: "Fits about 1–2 people working at once.",
    month_hours: 60,
    available: true,
    reason: null,
    ...over,
  });
  const sizes = [
    size({}),
    size({ instance_type: "m7g.2xlarge", name: "Large", label: "Large · 8 cores · 32 GB", price_usd: 129, price_line: "$129 a month", fits_line: "Fits about 5 people working at once.", month_hours: 250 }),
    size({ instance_type: "r7g.4xlarge", name: "Bigger", label: "Bigger · 16 cores · 128 GB", price_usd: 329, price_line: "$329 a month", fits_line: "Fits about 15 people working at once.", month_hours: 250, available: false, reason: "That size is full right now — talk to us." }),
  ];

  test("each row says the size, who it fits and its price; a full one says why and can't be picked", () => {
    const html = renderToStaticMarkup(
      <ComputerSizes sizes={sizes} value="t4g.large" onChange={none} larger="Need more than 64 cores or 512 GB? Talk to us." />,
    );
    expect(html).toContain("Standard · 2 cores · 8 GB");
    expect(html).toContain("Included with your plan");
    expect(html).toContain("Fits about 5 people working at once.");
    expect(html).toContain("$129 a month");
    expect(html).toContain("That size is full right now — talk to us.");
    expect(html).not.toContain("Fits about 15 people");
    expect(html).toContain("Need more than 64 cores or 512 GB? Talk to us.");
    expect(html.match(/disabled=""/g)?.length).toBe(1);
  });

  test("without onChange it only shows them", () => {
    const html = renderToStaticMarkup(<ComputerSizes sizes={sizes} value="t4g.large" />);
    expect(html.match(/disabled=""/g)?.length).toBe(3);
  });
});

describe("the team's computer", () => {
  test("setting up shows the server's line and its step, with no title", () => {
    const html = team(
      computer({ stage: "installing", headline: "Installing Aura and Claude on it.", progress_step: 3, progress_of: 5 }),
    );
    expect(html).toContain("Setting up Aura computer.");
    expect(html).toContain("Installing Aura and Claude on it.");
    expect(html).toContain("Step 3 of 5");
    expect(html).not.toContain("<h1");
  });

  test("waiting on the plan's payment says it moves on by itself", () => {
    const c = computer({ stage: "paying", headline: "Waiting for the payment to go through.", progress_step: 1, progress_of: 5 });
    expect(team(c)).toContain("Waiting for the plan&#x27;s payment to go through.");
  });

  test("ready says its hours used and left, and its size", () => {
    const html = team(
      computer({
        hours_line: "4 of 60 awake hours used this month · 56 left",
        size_label: "Large · 8 cores · 32 GB",
        size_note: "Becomes Bigger the next time it wakes up.",
      }),
    );
    expect(html).toContain("4 of 60 awake hours used this month · 56 left");
    expect(html).toContain("Large · 8 cores · 32 GB. Becomes Bigger the next time it wakes up.");
  });

  test("asleep offers waking it, with the month's hours", () => {
    const html = team(
      computer({ stage: "asleep", headline: "Asleep. It wakes up when someone sends it a message.", can_wake: true }),
    );
    expect(html).toContain("Asleep. It wakes up when someone sends it a message.");
    expect(html).toContain("Wake it now");
    expect(html).toContain("4 of 50 awake hours used this month.");
  });

  test("a used-up month says it sleeps until the 1st and offers no wake", () => {
    const html = team(
      computer({
        stage: "asleep",
        headline: "Asleep until the 1st of next month.",
        problem: "This month's 60 awake hours are used up, so the computer is asleep until the 1st. It wakes again on December 1.",
        awake_hours_this_month: 60,
        rests_until: "2026-12-01T00:00:00Z",
        can_wake: false,
      }),
    );
    expect(html).toContain("It wakes again on December 1.");
    expect(html).toContain("All 60 awake hours used this month.");
    expect(html).not.toContain("Wake it now");
  });

  test("a lapsed payment counts down instead of the hours", () => {
    const ends = new Date(Date.now() + 3 * 86_400_000 + 60_000).toISOString();
    const html = team(computer({ stage: "asleep", billing: "canceled", ends_at: ends }));
    expect(html).toContain("Pay again within 4 days");
    expect(html).not.toContain("awake hours used");
  });

  test("a failure says what went wrong and offers a retry only when one can run", () => {
    const failed = computer({ stage: "failed", headline: "Something went wrong setting it up.", problem: "The machine didn't start." });
    expect(team(failed)).toContain("The machine didn&#x27;t start.");
    expect(team(failed)).not.toContain("Try again");
    expect(team({ ...failed, can_retry: true })).toContain("Try again");
  });
});
