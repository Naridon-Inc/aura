// The claim under test: one failed read of the cloud place no longer empties
// it. The place is read every twenty seconds; a read that couldn't be made
// keeps what the last one read, and only an answer replaces it.

import { describe, expect, it } from "bun:test";

import type { CloudProblem } from "../../lib/cloudWorkspacesApi";
import { keptIdentity, keptRead, meAfterFailure, viewKey, type Read } from "./cloudPlaceKeep";

const problem: CloudProblem = { kind: "offline", message: "The cloud didn’t answer." };
const ready: Read<string[]> = { state: "ready", value: ["a", "b"] };
const failed: Read<string[]> = { state: "failed", problem };

describe("keptRead", () => {
  it("keeps a list already read when the next read fails, and says so", () => {
    expect(keptRead(ready, failed)).toEqual({ state: "ready", value: ["a", "b"], stale: problem });
  });

  it("lets a fresh answer replace the list, even an empty one", () => {
    expect(keptRead(ready, { state: "ready", value: [] })).toEqual({ state: "ready", value: [] });
  });

  it("clears the stale note once a read answers again", () => {
    const stale = keptRead(ready, failed);
    expect(keptRead(stale, ready)).toBe(ready);
  });

  it("says it failed when nothing was ever read", () => {
    expect(keptRead({ state: "loading" }, failed)).toBe(failed);
    expect(keptRead(failed, failed)).toBe(failed);
  });
});

describe("keptIdentity", () => {
  const known = { userId: "u1", login: "mo", orgName: "MHASK" };

  it("keeps who you are when the sign-in check and the id read both fail", () => {
    expect(keptIdentity(known, null, undefined)).toEqual(known);
  });

  it("takes what the sign-in says when it answers", () => {
    expect(keptIdentity(known, { user: " ana ", org_name: null, org_slug: "acme" }, "u2")).toEqual({
      userId: "u2",
      login: "ana",
      orgName: "acme",
    });
  });

  it("forgets the id when the cloud answers that there is none", () => {
    expect(keptIdentity(known, null, null).userId).toBeNull();
  });
});

describe("meAfterFailure", () => {
  it("hears an older cloud without the read as no id", () => {
    expect(meAfterFailure(new Error("HTTP 404 Not Found: "))).toBeNull();
  });

  it("hears a read that didn't get through as nothing new", () => {
    expect(meAfterFailure(new Error("HTTP 502 Bad Gateway"))).toBeUndefined();
    expect(meAfterFailure("error sending request: connection refused")).toBeUndefined();
  });
});

describe("viewKey", () => {
  it("is account-scoped, so an org switch drops it", () => {
    expect(viewKey("messages", "ws-1")).toBe("cloud:view:messages:ws-1");
    expect(viewKey("box-files", "m", null)).toBe("cloud:view:box-files:m:");
  });
});
