import { describe, it, expect } from "bun:test";

import { githubConnectUrl, upgradeUrl } from "./cloudPlan";

describe("upgradeUrl", () => {
  it("opens the console page that can actually sell a plan", () => {
    expect(upgradeUrl("https://auravcs.com")).toBe("https://app.auravcs.com/settings/billing");
    expect(upgradeUrl("https://api.auravcs.com/")).toBe("https://app.auravcs.com/settings/billing");
  });

  it("names Teams when the page asking needs Teams", () => {
    expect(upgradeUrl("https://auravcs.com", "team")).toBe("https://app.auravcs.com/settings/billing?plan=team");
    expect(upgradeUrl("https://auravcs.com", "cloud")).toBe("https://app.auravcs.com/settings/billing");
  });

  it("has nowhere to send a self-hosted server's people", () => {
    expect(upgradeUrl("https://aura.internal.example")).toBeNull();
    expect(upgradeUrl(null)).toBeNull();
  });
});

describe("githubConnectUrl", () => {
  it("opens the console page where a member connects their own GitHub", () => {
    expect(githubConnectUrl("https://auravcs.com")).toBe("https://app.auravcs.com/settings/git");
    expect(githubConnectUrl("https://app.auravcs.com/")).toBe("https://app.auravcs.com/settings/git");
  });

  it("has nowhere to send a self-hosted server's people", () => {
    expect(githubConnectUrl("https://aura.internal.example")).toBeNull();
    expect(githubConnectUrl(undefined)).toBeNull();
  });
});
