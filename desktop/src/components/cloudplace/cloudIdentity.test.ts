// Who "you" are in the cloud place. The sign-in's saved name is a GitHub login
// for one sign-in and an email for another, so it can't find you among the
// members; the cloud's user id does. Lose it and your own workspace is listed
// as nobody's ("Create your first workspace") and your own turn is drawn as a
// teammate's, on the left with your avatar.

import { describe, expect, mock, test } from "bun:test";

import type { CloudOrgMember } from "../../lib/api";
import type { CloudWorkspaceRow } from "../../lib/cloudWorkspacesApi";

type Server = {
  user: string | null;
  me: { user_id: string; github_login: string; email: string | null } | null;
  workspaces: CloudWorkspaceRow[];
};

const ash: CloudOrgMember = {
  user_id: "u-ash",
  github_login: "ash-gh",
  email: "Ash@Example.dev",
  display_name: "Ash",
  role: "owner",
};
const maya: CloudOrgMember = {
  user_id: "u-maya",
  github_login: "maya-chen",
  email: "maya@example.dev",
  display_name: "Maya Chen",
  role: "member",
};

const server: Server = { user: "ash@example.dev", me: null, workspaces: [] };

// The rest of the module stays real: the rows' imports reach plugins that
// read more of it than `invoke`.
const core = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...core,
  invoke: async (cmd: string) => {
    switch (cmd) {
      case "cloud_auth_status":
        return { connected: true, user: server.user, org_slug: "studio", cloud_url: "http://cloud.test" };
      case "cloud_me":
        if (!server.me) throw new Error("HTTP 404 Not Found: ");
        return server.me;
      case "cloud_org_members":
        return [ash, maya];
      case "cloud_repos":
        return [{ id: "r1", full_name: "studio/api", org_id: "o", org_slug: "studio", org_name: "Studio" }];
      case "cloud_workspaces_list":
        return server.workspaces;
      case "cloud_routines_list":
        return [];
      default:
        throw new Error(`not under test: ${cmd}`);
    }
  },
}));

// Other test files swap `lib/api` for a fake with a method or two, and a module
// mock outlives its file in a full run. The four calls the place reads are
// pinned here to the fake `invoke` above, so this file reads the server above
// whichever file ran first; the rest of the module is left as it is.
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

const { authorOf, hasOtherAuthors, meAmong } = await import("./cloudPeople");
const { cloudPlaceDataNow, reloadCloudPlace } = await import("./cloudPlaceStore");
const { cloudRowsOf, myWorkspaces } = await import("./useCloudRows");

const NOW = Date.parse("2026-11-10T12:00:00Z");

function workspace(id: string, by: string): CloudWorkspaceRow {
  return {
    id,
    objective: "HI",
    status: "running",
    intent: null,
    intent_by: null,
    created_by: by,
    agent: null,
    branch: "main",
    model: null,
    repo_id: "r1",
    source: "public-api",
    section_id: null,
    section: null,
    created_at: "2026-11-10T11:59:00Z",
    last_activity_at: "2026-11-10T11:59:30Z",
    ended_at: null,
  };
}

const rowsNow = () => cloudRowsOf(cloudPlaceDataNow(), [], [], NOW);

describe("meAmong", () => {
  test("the cloud's user id is you, whatever the sign-in saved as your name", () => {
    expect(meAmong([ash, maya], "u-ash", "Ash Display Name")).toBe("u-ash");
    expect(meAmong([], "u-ash", null)).toBe("u-ash");
  });

  test("without the id, an email sign-in still finds you, by email", () => {
    expect(meAmong([ash, maya], null, "ash@example.dev")).toBe("u-ash");
    expect(meAmong([ash, maya], null, "maya-chen")).toBe("u-maya");
  });

  test("a name that is no member's login or email is no one, not a guess", () => {
    expect(meAmong([ash, maya], null, "Ash")).toBeNull();
    expect(meAmong([ash, maya], null, "  ")).toBeNull();
    expect(meAmong([ash, maya], "  ", null)).toBeNull();
  });
});

describe("your workspaces and your turns", () => {
  test("signed in by email: the workspace you made is under yours", async () => {
    server.me = { user_id: "u-ash", github_login: "ash-gh", email: "ash@example.dev" };
    server.workspaces = [workspace("w-mine", "u-ash"), workspace("w-maya", "u-maya")];
    await reloadCloudPlace();
    const rows = rowsNow();
    expect(rows.me).toBe("u-ash");
    expect(myWorkspaces(rows).map((w) => w.id)).toEqual(["cws:w-mine"]);
  });

  test("an app whose cloud can't say who you are still finds you by your email", async () => {
    server.me = null;
    await reloadCloudPlace();
    expect(cloudPlaceDataNow().userId).toBeNull();
    expect(myWorkspaces(rowsNow()).map((w) => w.id)).toEqual(["cws:w-mine"]);
  });

  test("a workspace created a moment ago is yours on the read that follows the create", async () => {
    server.me = { user_id: "u-ash", github_login: "ash-gh", email: "ash@example.dev" };
    await reloadCloudPlace();
    expect(myWorkspaces(rowsNow()).map((w) => w.id)).not.toContain("cws:w-new");
    server.workspaces = [workspace("w-new", "u-ash"), ...server.workspaces];
    await reloadCloudPlace(); // what the create dialog does once the server has the row
    expect(myWorkspaces(rowsNow()).map((w) => w.id)).toContain("cws:w-new");
  });

  test("your own message is your turn, and a chat only you wrote in has no names", async () => {
    await reloadCloudPlace();
    const { members, me } = rowsNow();
    const turns = [
      { role: "user", author_id: "u-ash" },
      { role: "assistant", author_id: null },
    ];
    expect(hasOtherAuthors(turns, me)).toBe(false);
    const mine = authorOf(turns[0]!, members, me)!;
    expect(mine.own).toBe(true);
    expect(mine.member.name).toBe("You");
    expect(authorOf({ author_id: "u-maya" }, members, me)!.own).toBe(false);
  });
});

// A machine chat is one workspace, so one row. An earlier version also pushed
// the chat's local session to the cloud, which listed it again under the
// session's own id; this laptop remembers those ids, so Home leaves them out.
describe("a machine chat is listed once", () => {
  const listed = (entries: Record<string, string>) => {
    const keys = Object.keys(entries);
    return {
      get length() {
        return keys.length;
      },
      key: (i: number) => keys[i] ?? null,
      getItem: (k: string) => entries[k] ?? null,
    };
  };

  test("the copy of a machine chat's session is left out; its workspace and the rest stay", async () => {
    const boxChat = { ...workspace("w-box", "u-ash"), place: { kind: "machine", machine: "aura-runner" } } as CloudWorkspaceRow;
    server.me = { user_id: "u-ash", github_login: "ash-gh", email: "ash@example.dev" };
    server.workspaces = [boxChat, workspace("s-local-1", "u-ash"), workspace("w-other", "u-ash")];
    const saved = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = listed({
      "aura.cloudBoxChat.thread.w-box": "s-local-1",
      "aura.theme": "dark",
    });
    try {
      await reloadCloudPlace();
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = saved;
    }
    expect(myWorkspaces(rowsNow()).map((w) => w.id)).toEqual(["cws:w-box", "cws:w-other"]);
  });

  test("with nothing remembered, every row is listed", async () => {
    await reloadCloudPlace();
    expect(myWorkspaces(rowsNow()).map((w) => w.id)).toEqual(["cws:w-box", "cws:s-local-1", "cws:w-other"]);
  });
});
