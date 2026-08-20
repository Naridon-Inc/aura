// The billing figure, fetched once for the three surfaces that show it.
//
// `cloud_billing_usage_by_member` is a network round-trip for a month's spend
// per teammate. Overview and Cost & usage are two tabs of the same workpane
// strip and are routinely open together; Settings → Team shows the same
// figure again. Arriving at the app asked billing the same question two or
// three times before anything was drawn.
//
// The subtle rule is the key. This is an org-wide figure with no repo in it,
// so the only thing that can distinguish two reads is the month — and the
// default "current" must not be folded into whichever month string that
// happens to be today, or an explicit request for this month would collide
// with the implicit one and the caller who asked for a specific month would
// silently be handed the other's answer.

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";

import { readSrc, stripComments } from "./support/code";

let calls: Array<string | undefined> = [];
let fail: string | null = null;
let total = 10;

mock.module("../src/lib/api", () => ({
  api: {
    cloudBillingUsageByMember: async (month?: string) => {
      calls.push(month);
      if (fail !== null) throw new Error(fail);
      return { month: month ?? "2026-07", members: [], total_cost_usd: total };
    },
  },
}));

const { fetchBillingUsage, invalidateBillingUsage } = await import(
  "../src/lib/billingCache"
);

const realNow = Date.now;

beforeEach(() => {
  calls = [];
  fail = null;
  total = 10;
  invalidateBillingUsage();
});

afterEach(() => {
  Date.now = realNow;
});

function advance(ms: number) {
  const from = Date.now();
  Date.now = () => from + ms;
}

describe("three surfaces, one round-trip", () => {
  it("Overview and Cost & usage mounting together cost one fetch", async () => {
    await Promise.all([fetchBillingUsage(), fetchBillingUsage()]);
    expect(calls.length).toBe(1);
  });

  it("Settings opened a moment later rides the same answer", async () => {
    await fetchBillingUsage();
    advance(3_000);
    await fetchBillingUsage();
    expect(calls.length).toBe(1);
  });

  it("all three get the same figure", async () => {
    const [a, b, c] = await Promise.all([
      fetchBillingUsage(),
      fetchBillingUsage(),
      fetchBillingUsage(),
    ]);
    expect(a.total_cost_usd).toBe(10);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("asks again once the window has passed", async () => {
    await fetchBillingUsage();
    advance(61_000);
    await fetchBillingUsage();
    expect(calls.length).toBe(2);
  });
});

describe("the month is the key", () => {
  it("two months are two different answers", async () => {
    await fetchBillingUsage("2026-06");
    await fetchBillingUsage("2026-07");
    expect(calls).toEqual(["2026-06", "2026-07"]);
  });

  it("a named month never collides with the default", async () => {
    // The server decides what "current" means. If the default were keyed as
    // today's month string, whichever call landed first would answer the
    // other — and one of the two surfaces would be showing a month it did
    // not ask for, with no way to tell.
    await fetchBillingUsage();
    await fetchBillingUsage("2026-07");
    expect(calls.length).toBe(2);
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toBe("2026-07");
  });

  it("the default is passed through as absent, not as a guessed month", async () => {
    await fetchBillingUsage();
    expect(calls[0]).toBeUndefined();
  });

  it("forgetting one month leaves the others alone", async () => {
    await fetchBillingUsage("2026-06");
    await fetchBillingUsage("2026-07");
    invalidateBillingUsage("2026-06");
    await fetchBillingUsage("2026-07");
    await fetchBillingUsage("2026-06");
    expect(calls).toEqual(["2026-06", "2026-07", "2026-06"]);
  });
});

describe("billing being unreachable is not a bill of zero", () => {
  it("rejects rather than answering with nothing spent", async () => {
    fail = "billing service unreachable";
    // Each surface catches this and falls back to its solo view. An empty
    // usage object here would render as a real, confident "$0.00".
    await expect(fetchBillingUsage()).rejects.toThrow(
      "billing service unreachable",
    );
  });

  it("caches nothing, so the next surface asks for real", async () => {
    fail = "billing service unreachable";
    await fetchBillingUsage().catch(() => {});
    fail = null;
    const got = await fetchBillingUsage();
    expect(got.total_cost_usd).toBe(10);
    expect(calls.length).toBe(2);
  });
});

describe("wiring", () => {
  it("nothing fetches the figure straight from the api", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    // `import.meta.dir`, not a URL pathname — this repo lives under a path
    // with a space in it, which a URL would percent-encode into nothing.
    const root = `${import.meta.dir}/../src/`;
    const offenders: string[] = [];
    for await (const rel of glob.scan(root)) {
      if (rel === "lib/api.ts" || rel === "lib/billingCache.ts") continue;
      const body = stripComments(await Bun.file(root + rel).text());
      if (body.includes("api.cloudBillingUsageByMember(")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the window is sized for arriving somewhere, not for polling", async () => {
    const ts = stripComments(await readSrc("lib/billingCache.ts"));
    const m = ts.match(/const FRESH_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    const ms = Number(m![1].replace(/_/g, ""));
    // No surface polls this; they all read on mount. Long enough to cover
    // several mounts, short enough that a dollar figure is never stale in a
    // way anyone would notice.
    expect(ms).toBeGreaterThanOrEqual(10_000);
    expect(ms).toBeLessThanOrEqual(300_000);
  });
});
