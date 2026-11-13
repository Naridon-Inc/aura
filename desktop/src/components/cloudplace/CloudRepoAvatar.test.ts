import { describe, expect, test } from "bun:test";

import { cloudRepoOwner } from "./CloudRepoAvatar";

describe("cloudRepoOwner", () => {
  test("an owner/name repository names its owner", () => {
    expect(cloudRepoOwner("acme/widgets")).toBe("acme");
    expect(cloudRepoOwner("  acme-labs/web.app ")).toBe("acme-labs");
  });

  test("the per-caller container has no owner to show", () => {
    expect(cloudRepoOwner("aura-workspace/u-123")).toBeNull();
  });

  test("anything that isn't owner/name has none either", () => {
    expect(cloudRepoOwner("")).toBeNull();
    expect(cloudRepoOwner(null)).toBeNull();
    expect(cloudRepoOwner("widgets")).toBeNull();
    expect(cloudRepoOwner("a/b/c")).toBeNull();
    expect(cloudRepoOwner("-bad/name")).toBeNull();
  });

  test("an owner GitHub would not accept as a login has none", () => {
    expect(cloudRepoOwner("bad-/name")).toBeNull();
    expect(cloudRepoOwner("ba--d/name")).toBeNull();
    expect(cloudRepoOwner("a".repeat(40) + "/name")).toBeNull();
    expect(cloudRepoOwner("a".repeat(39) + "/name")).toBe("a".repeat(39));
  });
});
