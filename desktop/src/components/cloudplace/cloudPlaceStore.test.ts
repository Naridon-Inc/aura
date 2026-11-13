// The claim under test, end to end through the store the sidebar and the
// page share: a refresh where every read fails — the sign-in check included —
// leaves the organization, the members and the workspaces on screen. Before,
// it published an empty org name and no "you", and the sidebar fell back to
// "Cloud" and "Create your first workspace" until the next refresh.

import { beforeEach, describe, expect, it, mock } from "bun:test";

let down = false;
const answers: Record<string, unknown> = {
  cloud_auth_status: { connected: true, user: "mo", org_name: "MHASK" },
  cloud_me: { user_id: "u1" },
  cloud_org_members: [{ user_id: "u1", login: "mo" }],
  cloud_repos: [],
  cloud_workspaces_list: [],
  cloud_routines_list: [],
};

// The rest of the module stays real: the app's api pulls in the event bridge,
// which needs it.
const tauriCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...tauriCore,
  invoke: async (cmd: string) => {
    if (down || !(cmd in answers)) throw new Error("HTTP 502: the cloud didn’t answer");
    return answers[cmd];
  },
}));

// A module mock outlives its file in a full run, and another file pins
// `lib/api`'s cloud reads to its own fake server. Pin the four the store reads
// to the fake above so this file always reads its own answers.
const { invoke: fakeInvoke } = await import("@tauri-apps/api/core");
const realApi = await import("../../lib/api");
mock.module("../../lib/api", () => ({
  ...realApi,
  api: {
    ...realApi.api,
    cloudAuthStatus: () => fakeInvoke("cloud_auth_status"),
    cloudMe: () => fakeInvoke("cloud_me"),
    cloudOrgMembers: () => fakeInvoke("cloud_org_members"),
    cloudRepos: () => fakeInvoke("cloud_repos"),
  },
}));

const { cloudPlaceDataNow, reloadCloudPlace } = await import("./cloudPlaceStore");
const { forgetAccountScoped } = await import("../../lib/resourceCache");

beforeEach(() => {
  down = false;
  forgetAccountScoped();
});

describe("cloud place store", () => {
  it("reads the org, who you are and its members", async () => {
    await reloadCloudPlace();
    const d = cloudPlaceDataNow();
    expect(d.orgName).toBe("MHASK");
    expect(d.userId).toBe("u1");
    expect(d.members.state).toBe("ready");
  });

  it("keeps all of it through a refresh where every read fails", async () => {
    await reloadCloudPlace();
    down = true;
    await reloadCloudPlace();
    const d = cloudPlaceDataNow();
    expect(d.orgName).toBe("MHASK");
    expect(d.login).toBe("mo");
    expect(d.userId).toBe("u1");
    expect(d.members).toMatchObject({ state: "ready", value: [{ user_id: "u1" }] });
    expect(d.members).toHaveProperty("stale");
    expect(d.workspaces.state).toBe("ready");
  });

  it("says it failed when nothing was read yet", async () => {
    down = true;
    await reloadCloudPlace();
    expect(cloudPlaceDataNow().members.state).toBe("failed");
  });

  it("starts from nothing for another account", async () => {
    await reloadCloudPlace();
    forgetAccountScoped();
    const d = cloudPlaceDataNow();
    expect(d.orgName).toBe("");
    expect(d.members.state).toBe("loading");
  });
});
