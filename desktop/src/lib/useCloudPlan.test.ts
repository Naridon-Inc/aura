// The claim under test: the plan is one read for the whole window. The
// sidebar, the page gate and the plan buttons share it, a second open finds
// it already known instead of "Reading your organization's plan…", and a
// renewal that fails leaves the gate open.

import { beforeEach, describe, expect, it, mock } from "bun:test";

let down = false;
const calls: Record<string, number> = {};
const answers: Record<string, unknown> = {
  cloud_auth_status: { connected: true, cloud_url: "https://cloud" },
  cloud_billing_status: { plan: "pro", effective_plan: "pro", trial_active: false },
};

// The rest of the module stays real: the app's api pulls in the event bridge,
// which needs it.
const tauriCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...tauriCore,
  invoke: async (cmd: string) => {
    calls[cmd] = (calls[cmd] ?? 0) + 1;
    if (down || !(cmd in answers)) throw new Error("HTTP 502: the cloud didn’t answer");
    return answers[cmd];
  },
}));

// In a full run another test file may already have replaced lib/api, and its
// replacement reaches whichever invoke was mocked first. Pin the two reads this
// store makes to this file's own invoke so they land in `calls` here.
const { invoke: fakeInvoke } = await import("@tauri-apps/api/core");
const realApi = await import("./api");
mock.module("./api", () => ({
  ...realApi,
  api: {
    ...realApi.api,
    cloudAuthStatus: () => fakeInvoke("cloud_auth_status"),
    cloudBillingStatus: () => fakeInvoke("cloud_billing_status"),
  },
}));

const { cloudPlanNow, refreshCloudPlan } = await import("./useCloudPlan");
const { forgetAccountScoped } = await import("./resourceCache");

beforeEach(() => {
  down = false;
  forgetAccountScoped();
  for (const k of Object.keys(calls)) delete calls[k];
});

describe("cloud plan store", () => {
  it("reads the plan", async () => {
    await refreshCloudPlan();
    expect(cloudPlanNow()).toMatchObject({ state: "ready", plan: "Pro", cloudUrl: "https://cloud" });
  });

  it("asks once for everyone asking at the same time", async () => {
    await Promise.all([refreshCloudPlan(), refreshCloudPlan(), refreshCloudPlan()]);
    expect(calls.cloud_billing_status).toBe(1);
  });

  it("keeps the plan through a renewal that fails", async () => {
    await refreshCloudPlan();
    down = true;
    await refreshCloudPlan(true);
    expect(cloudPlanNow()).toMatchObject({ state: "ready", plan: "Pro" });
  });

  it("starts from loading for another account", async () => {
    await refreshCloudPlan();
    forgetAccountScoped();
    expect(cloudPlanNow().state).toBe("loading");
  });

  it("drops an answer asked as the previous account", async () => {
    const asked = refreshCloudPlan(true);
    forgetAccountScoped();
    await asked;
    expect(cloudPlanNow().state).toBe("loading");
  });
});
