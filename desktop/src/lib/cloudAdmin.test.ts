import { describe, expect, it } from "bun:test";
import { keyLine, liveKeys, slugOf, slugOk, type CloudApiKey } from "./cloudAdmin";

const key = (over: Partial<CloudApiKey>): CloudApiKey => ({ id: "k", label: "CI", scopes: ["repo:read"], ...over });

describe("cloudAdmin", () => {
  it("makes an address from a name", () => {
    expect(slugOf("Acme Labs, Inc.")).toBe("acme-labs-inc");
    expect(slugOf("  --Ünïcode team-- ")).toBe("unicode-team");
    expect(slugOk(slugOf("Acme Labs"))).toBe(true);
  });

  it("refuses addresses the server would", () => {
    expect(slugOk("a")).toBe(false);
    expect(slugOk("-acme")).toBe(false);
    expect(slugOk("acme-")).toBe(false);
    expect(slugOk("Acme")).toBe(false);
    expect(slugOk("acme-labs")).toBe(true);
  });

  it("leaves revoked keys out", () => {
    const keys = [key({ id: "a" }), key({ id: "b", revoked_at: "2026-11-01T00:00:00Z" })];
    expect(liveKeys(keys).map((k) => k.id)).toEqual(["a"]);
  });

  it("says when a key was made and used", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    expect(keyLine(key({ created_at: "2026-11-11T08:00:00Z", key_prefix: "aura_ab12" }), now)).toBe(
      "Created today · never used · aura_ab12…",
    );
    expect(keyLine(key({ created_at: "2026-11-10T08:00:00Z", last_used_at: "2026-11-11T09:00:00Z" }), now)).toBe(
      "Created yesterday · used today",
    );
  });
});
