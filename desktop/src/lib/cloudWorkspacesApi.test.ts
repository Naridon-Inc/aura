// The claim under test: a plan refusal from the cloud names the plan it
// needs. Every paid route refuses in one shape, so the app can say "Cloud
// workspaces need the Pro plan." instead of a bare "not on your plan".

import { describe, expect, it, mock } from "bun:test";

mock.module("@tauri-apps/api/core", () => ({
  invoke: async () => {
    throw new Error("not under test");
  },
}));

const { CLOUD_UNREACHED, cloudProblem, ownerOf } = await import("./cloudWorkspacesApi");

const refusal = (body: Record<string, unknown>) => `HTTP 403: ${JSON.stringify(body)}`;

describe("cloudProblem — plan refusals", () => {
  it("names the feature and the plan the server says it needs", () => {
    const p = cloudProblem(
      refusal({
        error: "upgrade_required",
        feature: "cloud_workspaces",
        plan_needed: "pro",
        current_plan: "free",
        message: "Cloud workspaces need the Pro plan.",
      }),
    );
    expect(p).toEqual({
      kind: "upgrade",
      message: "Cloud workspaces need the Pro plan.",
      feature: "cloud_workspaces",
      planNeeded: "pro",
    });
  });

  it("says the plan even when the server sent no sentence", () => {
    const p = cloudProblem(refusal({ error: "upgrade_required", feature: "team_invites", plan_needed: "team" }));
    expect(p.kind).toBe("upgrade");
    expect(p.message).toBe("This needs the Team plan.");
  });

  it("falls back to the general sentence for an older server's bare refusal", () => {
    const p = cloudProblem(refusal({ error: "upgrade_required", message: "This feature requires the team plan" }));
    expect(p).toEqual({
      kind: "upgrade",
      message: "Your organization’s plan doesn’t include this yet.",
      feature: undefined,
      planNeeded: undefined,
    });
  });

  it("does not trust a plan word it does not know", () => {
    const p = cloudProblem(refusal({ error: "upgrade_required", plan_needed: "platinum", message: "Buy platinum" }));
    expect(p.message).toBe("Your organization’s plan doesn’t include this yet.");
  });

  it("keeps a plain 403 a permissions problem, not a plan one", () => {
    expect(cloudProblem("HTTP 403: Forbidden").kind).toBe("forbidden");
  });

  it("survives a body that is not JSON", () => {
    expect(cloudProblem("HTTP 403: upgrade_required {not json").kind).toBe("upgrade");
  });
});

describe("ownerOf", () => {
  it("is the creator, even when someone else recorded the intent", () => {
    expect(ownerOf({ intent_by: "u-intent", created_by: "u-creator" })).toBe("u-creator");
    expect(ownerOf({ intent_by: null, created_by: "u-creator" })).toBe("u-creator");
  });

  it("is who recorded the intent on an older row with no creator", () => {
    expect(ownerOf({ intent_by: "u-intent" })).toBe("u-intent");
    expect(ownerOf({ intent_by: "u-intent", created_by: "" })).toBe("u-intent");
  });

  it("is nobody for an older row that records neither", () => {
    expect(ownerOf({ intent_by: null })).toBeNull();
    expect(ownerOf({ intent_by: null, created_by: null })).toBeNull();
  });
});

describe("cloudProblem — a cloud that can't be reached", () => {
  it("says it plainly instead of the request library's line", () => {
    const raw =
      "GET https://api.auravcs.com/api/v2/public/workspaces: error sending request for url (https://api.auravcs.com/api/v2/public/workspaces)";
    const p = cloudProblem(raw);
    expect(p.kind).toBe("offline");
    expect(p.message).toBe(CLOUD_UNREACHED);
    expect(p.message).not.toContain("https://");
  });

  it("covers a name that won't resolve, a refused and a timed-out connection", () => {
    for (const raw of [
      "GET https://api.auravcs.com/x: dns error: failed to lookup address information",
      "POST https://api.auravcs.com/x: tcp connect error: Connection refused (os error 61)",
      "GET https://api.auravcs.com/x: operation timed out",
    ])
      expect(cloudProblem(raw).kind).toBe("offline");
  });

  it("leaves an answer the server did send to the other rules", () => {
    expect(cloudProblem("HTTP 504 Gateway Timeout: upstream timed out").kind).toBe("other");
    expect(cloudProblem("HTTP 503: maintenance").kind).toBe("unavailable");
    expect(cloudProblem("no cloud_api_token").kind).toBe("signed_out");
  });
});

describe("cloudProblem — the member's own GitHub", () => {
  it("keeps the server's sentence and reason instead of the generic 403", () => {
    const p = cloudProblem(
      refusal({
        error: "Your GitHub account @mo can’t open uniskool/web. Ask whoever manages it on GitHub to add you.",
        reason: "github_cannot_open",
      }),
    );
    expect(p).toEqual({
      kind: "github",
      reason: "github_cannot_open",
      message: "Your GitHub account @mo can’t open uniskool/web. Ask whoever manages it on GitHub to add you.",
    });
  });

  it("reads a not-connected refusal from a 409", () => {
    const p = cloudProblem(`HTTP 409 Conflict: ${JSON.stringify({ error: "connect first", reason: "github_not_connected" })}`);
    expect(p.kind).toBe("github");
  });

  it("leaves other 403s as they were", () => {
    expect(cloudProblem(refusal({ error: "not a member" })).kind).toBe("forbidden");
  });
});
