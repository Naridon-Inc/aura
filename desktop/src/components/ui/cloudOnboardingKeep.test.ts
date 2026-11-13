import { describe, expect, test } from "bun:test";

import { keptSetup, standingRepos } from "./cloud-onboarding";

describe("the setup steps keep your place", () => {
  test("a kept place comes back, clamped", () => {
    expect(keptSetup(JSON.stringify({ step: 2, furthest: 2, repos: ["a/b"], org: "a" }))).toEqual({
      step: 2,
      furthest: 2,
      repos: ["a/b"],
      org: "a",
    });
    expect(keptSetup(JSON.stringify({ step: 3, furthest: 9, repos: [1, "x/y"] }))).toEqual({
      step: 3,
      furthest: 3,
      repos: ["x/y"],
      org: "",
    });
    expect(keptSetup(JSON.stringify({ step: 1, furthest: 0 }))?.furthest).toBe(1);
  });

  test("junk or a step that doesn't exist starts over", () => {
    expect(keptSetup(null)).toBeNull();
    expect(keptSetup("nope")).toBeNull();
    expect(keptSetup(JSON.stringify({ step: 7 }))).toBeNull();
    expect(keptSetup(JSON.stringify({ step: -1 }))).toBeNull();
  });
});

describe("picks once the repositories are known", () => {
  test("an only repository is picked", () => {
    expect(standingRepos([], ["acme/app"])).toEqual(["acme/app"]);
  });

  test("picks the org no longer has go; the rest stand as they were", () => {
    const picked = ["acme/app", "acme/api"];
    expect(standingRepos(picked, ["acme/app", "acme/api", "acme/web"])).toBe(picked);
    expect(standingRepos(picked, ["acme/api", "acme/web"])).toEqual(["acme/api"]);
  });

  test("several to choose from and nothing picked: nothing is picked for you", () => {
    expect(standingRepos([], ["acme/app", "acme/api"])).toEqual([]);
  });
});
