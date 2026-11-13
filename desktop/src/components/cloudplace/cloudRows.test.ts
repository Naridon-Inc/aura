import { describe, expect, test } from "bun:test";

import type { CloudOrgMember, CloudRepo } from "../../lib/api";
import type { CloudWorkspaceRow } from "../../lib/cloudWorkspacesApi";
import {
  PUBLIC_ROW_PREFIX,
  cloudWorkOnly,
  githubRepoPage,
  initialsOf,
  isCloudWork,
  memberOf,
  newestActivityMs,
  ownersOf,
  publicWorkspaceOverview,
  repoLabel,
  rowNumber,
} from "./cloudRows";

const NOW = Date.parse("2026-11-09T12:00:00Z");

function row(over: Partial<CloudWorkspaceRow> = {}): CloudWorkspaceRow {
  return {
    id: "3f1c9a20-0000-4000-8000-000000000000",
    objective: "Fix the login redirect\nmore words",
    status: "running",
    intent: null,
    intent_by: "u1",
    agent: null,
    branch: "main",
    model: null,
    repo_id: "r1",
    source: "public-api",
    section_id: null,
    section: null,
    created_at: "2026-11-09T10:00:00Z",
    last_activity_at: "2026-11-09T11:58:00Z",
    ended_at: null,
    ...over,
  };
}

const repos = new Map<string, CloudRepo>([
  ["r1", { id: "r1", full_name: "studio/api", org_id: "o", org_slug: "studio", org_name: "Studio" }],
  ["r2", { id: "r2", full_name: "aura-workspace/u1", org_id: "o", org_slug: "studio", org_name: "Studio" }],
]);

describe("newestActivityMs", () => {
  test("the freshest workspace's last activity, falling back to when it was opened", () => {
    const rows = [
      row({ last_activity_at: "2026-11-09T11:00:00Z" }),
      row({ last_activity_at: null, created_at: "2026-11-09T11:59:30Z" }),
      row({ last_activity_at: "2026-11-09T11:58:00Z" }),
    ];
    expect(newestActivityMs(rows)).toBe(Date.parse("2026-11-09T11:59:30Z"));
  });

  test("no rows, or no readable time on any, is no time at all", () => {
    expect(newestActivityMs([])).toBeNull();
    expect(newestActivityMs([row({ last_activity_at: null, created_at: "not a date" })])).toBeNull();
  });
});

describe("a workspace's age reads against the clock it is given", () => {
  test("the same row ages as the clock moves — it does not stay 'just now'", () => {
    const at = row({ last_activity_at: "2026-11-09T11:59:58Z" });
    expect(publicWorkspaceOverview(at, repos, NOW).timeLabel).toBe("just now");
    expect(publicWorkspaceOverview(at, repos, NOW + 30_000).timeLabel).toBe("32s ago");
    expect(publicWorkspaceOverview(at, repos, NOW + 10 * 60_000).timeLabel).toBe("10m ago");
  });
});

describe("publicWorkspaceOverview", () => {
  test("first line of the objective, the repository's short name, running is in progress", () => {
    const w = publicWorkspaceOverview(row(), repos, NOW);
    expect(w.id).toBe(`${PUBLIC_ROW_PREFIX}${row().id}`);
    expect(w.title).toBe("Fix the login redirect");
    expect(w.project).toBe("api");
    expect(w.stage).toBe("in-progress");
    expect(w.workflow.state).toBe("working");
    expect(w.archived).toBe(false);
    expect(w.timeLabel).not.toBe("");
  });

  test("archived is archived and done; the implicit container is no repository", () => {
    const w = publicWorkspaceOverview(row({ status: "archived", repo_id: "r2" }), repos, NOW);
    expect(w.archived).toBe(true);
    expect(w.stage).toBe("done");
    expect(w.project).toBe("No repository");
  });

  test("a row with no name says so instead of borrowing one", () => {
    expect(publicWorkspaceOverview(row({ objective: null }), repos, NOW).title).toBe("Untitled workspace");
  });
});

describe("members and owners", () => {
  const m: CloudOrgMember = {
    user_id: "u1",
    github_login: "maya-chen",
    github_avatar: "https://avatars.example/u1.png",
    display_name: "Maya Chen",
    role: "owner",
  };

  test("a member keeps their photo and their role", () => {
    const c = memberOf(m, new Set(["u1"]));
    expect(c.photo).toBe("https://avatars.example/u1.png");
    expect(c.initials).toBe("MC");
    expect(c.role).toBe("Admin");
    expect(c.active).toBe(true);
  });

  test("no photo means letters", () => {
    expect(memberOf({ ...m, github_avatar: null }).photo).toBeUndefined();
    expect(initialsOf("@leo")).toBe("L");
  });

  test("only openers who are members become owners — nobody is borrowed", () => {
    const owners = ownersOf([row(), row({ id: "x2", intent_by: "stranger" })], [memberOf(m)]);
    expect(owners).toEqual({ [`${PUBLIC_ROW_PREFIX}${row().id}`]: "u1" });
  });

  test("the creator owns a workspace even when someone else's intent opened it", () => {
    const made = row({ intent_by: "stranger", created_by: "u1" });
    expect(ownersOf([made], [memberOf(m)])).toEqual({ [`${PUBLIC_ROW_PREFIX}${row().id}`]: "u1" });
  });
});

describe("rowNumber", () => {
  test("is the real id, shortened", () => {
    expect(rowNumber(`${PUBLIC_ROW_PREFIX}3f1c9a20-0000`)).toBe("3F1C9A");
    expect(rowNumber("cloud:cloud-ab12cd34")).toBe("AB12CD");
  });
  test("repoLabel", () => {
    expect(repoLabel(null)).toBe("No repository");
    expect(repoLabel("studio/web")).toBe("web");
  });
});

describe("githubRepoPage", () => {
  test("an owner/name opens on GitHub", () => {
    expect(githubRepoPage("acme/web-app")).toBe("https://github.com/acme/web-app");
  });
  test("the per-caller container and non-names have no page", () => {
    expect(githubRepoPage("aura-workspace/u_123")).toBe("");
    expect(githubRepoPage("web-app")).toBe("");
    expect(githubRepoPage("")).toBe("");
    expect(githubRepoPage(null)).toBe("");
    expect(githubRepoPage("acme/web app")).toBe("");
  });
});

// The rows below are shaped as one organization's production listing came
// back, names and ids replaced: of its forty newest rows, one was a workspace
// the cloud opened. The rest were agent sessions laptops had reported — the
// desktop's heartbeat and the sessions the CLI rebuilt from its notes — with
// no owner, mostly no objective, and one desktop session under the same id in
// every project that desktop had open.
describe("cloud work only", () => {
  const laptop = (id: string, repo: string, over: Partial<CloudWorkspaceRow> = {}): CloudWorkspaceRow =>
    row({
      id,
      objective: null,
      intent: null,
      intent_by: null,
      created_by: null,
      agent: null,
      branch: "main",
      repo_id: repo,
      source: "aura-shell",
      place: null,
      place_linked_by: null,
      created_at: "2026-11-08T23:30:00Z",
      last_activity_at: "2026-11-09T00:00:00Z",
      ...over,
    });
  const DESK = "9f3e1c2a-0000-4000-8000-00000000d35c";
  const listing: CloudWorkspaceRow[] = [
    row({ id: "c10d0001-0000-4000-8000-000000000001", created_by: "u-me", intent_by: "u-me" }),
    laptop("c10d0002-0000-4000-8000-000000000002", "r1", { objective: "Claude Code" }),
    laptop("c10d0003-0000-4000-8000-000000000003", "r2", {
      objective: "storefront",
      source: "aura-cli",
      agent: "claude",
    }),
    ...["r1", "r2", "r3", "r4"].map((repo) => laptop(DESK, repo)),
  ];

  test("a laptop's reported session is not cloud work", () => {
    expect(listing.filter(isCloudWork).map((w) => w.id)).toEqual(["c10d0001-0000-4000-8000-000000000001"]);
    // The older desktop spelling is a laptop too.
    expect(isCloudWork({ source: "aura-desktop" })).toBe(false);
  });

  test("the server's origin decides when it is given", () => {
    expect(isCloudWork({ origin: "cloud", source: "aura-shell" })).toBe(true);
    expect(isCloudWork({ origin: "device", source: "public-api" })).toBe(false);
    // Routines and chat bots open cloud workspaces under their own source.
    expect(isCloudWork({ source: "routine" })).toBe(true);
    expect(isCloudWork({ source: "bot-slack" })).toBe(true);
  });

  test("Home is left with the cloud's own workspace, once", () => {
    expect(cloudWorkOnly(listing).map((w) => w.id)).toEqual(["c10d0001-0000-4000-8000-000000000001"]);
  });

  test("a workspace listed twice is drawn once, as its latest", () => {
    const older = row({ id: "c10d0009-0000-4000-8000-000000000009", repo_id: "r1", last_activity_at: "2026-11-09T09:00:00Z" });
    const newer = row({ id: "c10d0009-0000-4000-8000-000000000009", repo_id: "r2", last_activity_at: "2026-11-09T11:00:00Z" });
    const kept = cloudWorkOnly([older, newer]);
    expect(kept).toEqual([newer]);
    const ids = kept.map((w) => publicWorkspaceOverview(w, repos, NOW).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a teammate's filter credits only what they opened in the cloud", () => {
    const members = [
      memberOf({ user_id: "u-me", github_login: "me", display_name: "Me", role: "owner" } as CloudOrgMember),
      memberOf({ user_id: "u-mate", github_login: "mate", display_name: "Mate", role: "member" } as CloudOrgMember),
    ];
    const owners = ownersOf(cloudWorkOnly(listing), members);
    expect(Object.values(owners)).toEqual(["u-me"]);
    expect(Object.values(owners).includes("u-mate")).toBe(false);
  });
});
