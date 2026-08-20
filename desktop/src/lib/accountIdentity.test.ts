import { describe, expect, test } from "bun:test";

import type { CloudAuthStatus } from "./api";
import { gitIdentityFromAccount, noreplyHost } from "./accountIdentity";

const acct = (over: Partial<CloudAuthStatus>): CloudAuthStatus => ({
  connected: true,
  user: "mhask",
  org_slug: null,
  cloud_url: "https://auravcs.com",
  ...over,
});

describe("gitIdentityFromAccount", () => {
  test("derives name + a stable no-reply email from the account", () => {
    expect(gitIdentityFromAccount(acct({}))).toEqual({
      name: "mhask",
      email: "mhask@users.noreply.auravcs.com",
    });
  });

  test("signed out → nothing to derive", () => {
    expect(gitIdentityFromAccount(acct({ connected: false }))).toBeNull();
    expect(gitIdentityFromAccount(null)).toBeNull();
  });

  test("connected but no username → nothing (don't invent an identity)", () => {
    expect(gitIdentityFromAccount(acct({ user: null }))).toBeNull();
    expect(gitIdentityFromAccount(acct({ user: "  " }))).toBeNull();
  });

  test("the email host follows the account's own cloud host", () => {
    const got = gitIdentityFromAccount(
      acct({ user: "ash", cloud_url: "https://cloud.example.dev/api" }),
    );
    expect(got?.email).toBe("ash@users.noreply.cloud.example.dev");
  });
});

describe("noreplyHost", () => {
  test("strips scheme, path and port", () => {
    expect(noreplyHost("https://auravcs.com")).toBe("auravcs.com");
    expect(noreplyHost("https://auravcs.com:8443/x/y")).toBe("auravcs.com");
    expect(noreplyHost("http://api.auravcs.com/")).toBe("api.auravcs.com");
  });

  test("falls back to a well-formed host when the url is junk", () => {
    expect(noreplyHost("")).toBe("auravcs.com");
    expect(noreplyHost(null)).toBe("auravcs.com");
    expect(noreplyHost("localhost")).toBe("auravcs.com"); // no dot → not a real host
  });
});
