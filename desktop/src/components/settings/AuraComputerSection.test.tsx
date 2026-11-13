// Run with: bun test src/components/settings/AuraComputerSection.test.tsx
//
// Settings › Cloud computer shows the team's Aura computer as it really is.
// A team whose computer is ready, building or failed sees that — with the
// month's hours used and left — and never "Set up a computer".

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AuraComputer, AuraComputerOffer, AuraComputerStatus } from "../../lib/auraComputer";
import { putAuraComputer } from "../../lib/useAuraComputer";
import { AuraComputerSection, hoursUsed } from "./AuraComputerSection";

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
  summary: "A computer in the cloud.",
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
  awake_hours_this_month: 12,
  hours_left_this_month: 48,
  hours_line: "12 of 60 awake hours used this month · 48 left",
  fair_use_hours: 50,
  month_hours: 60,
  size: "t4g.large",
  size_label: "Standard · 2 cores · 8 GB",
  sleeps_after_minutes: 30,
  place_id: "p-1",
  instance_id: "i-1",
  region: "eu-central-1",
  can_wake: false,
  can_retry: false,
  since: "2026-11-12T10:00:00Z",
  ...over,
});

const shown = (status: AuraComputerStatus) => {
  putAuraComputer(status);
  return renderToStaticMarkup(<AuraComputerSection />);
};

describe("a team with a computer", () => {
  test("ready shows its name, the hours used and left, and its size", () => {
    const html = shown({ offer, computer: computer({}), ended: null });
    expect(html).toContain("Aura computer");
    expect(html).toContain("Ready. It answers your team&#x27;s chats.");
    expect(html).toContain("12 of 60 awake hours used this month · 48 left");
    expect(html).toContain("Standard · 2 cores · 8 GB");
    expect(html).not.toContain("Set up a computer");
    expect(html).not.toContain("Upgrade");
  });

  test("building shows the server's step", () => {
    const html = shown({
      offer,
      computer: computer({ stage: "installing", headline: "Installing Aura and Claude on it.", progress_step: 3, progress_of: 5 }),
      ended: null,
    });
    expect(html).toContain("Installing Aura and Claude on it. · Step 3 of 5");
  });

  test("failed says what went wrong and offers a retry when one can run", () => {
    const html = shown({
      offer,
      computer: computer({ stage: "failed", headline: "Something went wrong setting it up.", problem: "The machine didn't start.", can_retry: true }),
      ended: null,
    });
    expect(html).toContain("The machine didn&#x27;t start.");
    expect(html).toContain("Try again");
  });

  test("an admin on Teams can pick a bigger size", () => {
    const sizes = [
      { instance_type: "t4g.large", name: "Standard", label: "Standard · 2 cores · 8 GB", cores: 2, memory_gb: 8, disk_gb: 40, price_usd: null, price_line: "Included with your plan", fits: "1–2", fits_line: "Fits about 1–2 people working at once.", month_hours: 119, available: true, reason: null },
      { instance_type: "m7g.2xlarge", name: "Large", label: "Large · 8 cores · 32 GB", cores: 8, memory_gb: 32, disk_gb: 100, price_usd: 129, price_line: "$129 a month", fits: "5", fits_line: "Fits about 5 people working at once.", month_hours: 250, available: true, reason: null },
    ];
    const html = shown({ offer: { ...offer, can_change_size: true, sizes }, computer: computer({}), ended: null });
    expect(html).toContain("Change size");
    expect(html).toContain("$129 a month");
  });
});

describe("a team without one", () => {
  test("Free and trials are offered Pro", () => {
    const html = shown({
      offer: { ...offer, available: false, included: false, upgrade_to: "pro", reason: "A cloud computer comes with Pro or Teams." },
      computer: null,
      ended: null,
    });
    expect(html).toContain("A cloud computer comes with Pro or Teams.");
    expect(html).toContain("Upgrade to Pro");
    expect(html).not.toContain("$35");
  });

  test("a paying team that has none yet can start it", () => {
    const html = shown({ offer: { ...offer, can_start: true }, computer: null, ended: null });
    expect(html).toContain("Start the computer");
  });

  test("a team whose computer couldn't start by itself is told why, with no button", () => {
    const why = "The computer starts when your trial ends and the first payment goes through.";
    const html = shown({ offer: { ...offer, can_start: true, start_problem: why }, computer: null, ended: null });
    expect(html).toContain(why);
    expect(html).not.toContain("Start the computer");
  });

  test("a member is told it starts by itself, not to find an admin", () => {
    const html = shown({ offer, computer: null, ended: null });
    expect(html).toContain("It starts by itself");
    expect(html).not.toContain("An admin of your team can start it");
  });

  test("a server without computers shows nothing", () => {
    expect(shown({ offer: null, computer: null, ended: null })).toBe("");
  });
});

test("the hours bar fills with the month's awake hours", () => {
  expect(hoursUsed({ awake_hours_this_month: 15, month_hours: 60 })).toBeCloseTo(0.25);
  expect(hoursUsed({ awake_hours_this_month: 90, month_hours: 60 })).toBe(1);
  expect(hoursUsed({ awake_hours_this_month: 5, month_hours: 0 })).toBeNull();
});
