import { describe, expect, test } from "bun:test";

import { isGrantedHandle, parseGrantedHandle } from "./grant";

describe("reading which account a machine may be switched off in", () => {
  test("a granted handle says which account it belongs to", () => {
    // The whole reason the prefix exists. Without it the same machine id would
    // be sent to whichever account happened to be set up, and on a laptop with
    // two of them that is a stop against the wrong company's box.
    expect(parseGrantedHandle("grant:acme-eu/i-0123456789abcdef0")).toEqual({
      account: "acme-eu",
      machine: "i-0123456789abcdef0",
    });
    expect(isGrantedHandle("grant:acme-eu/i-0123456789abcdef0")).toBe(true);
  });

  test("a machine Aura made names no account", () => {
    // The ordinary handle, unqualified and unchanged — which is what keeps
    // every row written before grants existed reading exactly as it did.
    expect(parseGrantedHandle("i-0123456789abcdef0")).toBeNull();
    expect(isGrantedHandle("i-0123456789abcdef0")).toBe(false);
  });

  test("nothing at all is not a granted handle", () => {
    // The state every row is in on an install where nobody has granted
    // anything, which is the shipping default rather than a fault.
    for (const nothing of [null, undefined, "", "   "]) {
      expect(isGrantedHandle(nothing)).toBe(false);
    }
  });

  test("half a handle is not a handle", () => {
    // Each of these would otherwise offer a Sleep button for a row that names
    // an account with no machine in it, or a machine in no account.
    for (const broken of [
      "grant:",
      "grant:acme-eu",
      "grant:/i-0abc1234",
      "grant:acme-eu/",
      "grant:/",
    ]) {
      expect(parseGrantedHandle(broken), `${broken} was read as a handle`).toBeNull();
    }
  });

  test("the machine's own handle survives the trip whole", () => {
    // Split at the FIRST separator, exactly as the backend splits it, so
    // anything the cloud puts after one arrives intact. A truncated id is the
    // worst shape of failure here: it still looks like a handle, and it names a
    // different machine.
    expect(parseGrantedHandle("grant:acme-eu/proj/i-0abc1234")).toEqual({
      account: "acme-eu",
      machine: "proj/i-0abc1234",
    });
  });

  test("a hand-typed handle is trimmed before it becomes an identity", () => {
    // Grants are written into a file by hand. A trailing space would produce an
    // account name that never matches the one set up — a place that offers to
    // sleep and then says the account was never configured.
    expect(parseGrantedHandle("  grant: acme-eu / i-0123456789abcdef0  ")).toEqual({
      account: "acme-eu",
      machine: "i-0123456789abcdef0",
    });
  });
});
