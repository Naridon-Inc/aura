// An org place offers only that org's projects.
//
//   bun test
//
// A box discovers projects box-wide. That is the right way to find them — it is
// how the two repos somebody cloned by hand years before any of this existed are
// still visible — and it is also why a shared runner hands every member one
// listing containing every org's work on the disk. A contractor opening their
// client's runner reads the client's *other* client's repo names off the
// picker, and nobody finds out, because a list of directories does not look like
// a disclosure.
//
// The narrowing rule is proved on the Rust side (`manager::brain::place_projects`,
// 14 cases, plus the W7 row of the conformance matrix which asks it of every
// place mode). What is pinned here is the seam around it — the three ways this
// comes undone on the frontend, each of them silent:
//
// 1. A SURFACE GOES BACK TO THE RAW LIST. Someone reaches past `projects` for
//    something that isn't narrowed, or the command starts handing back a bare
//    array again. It compiles, it draws rows, and the filter is simply gone.
//
// 2. THE SHORTER LIST SAYS NOTHING. This is the worst version of the feature.
//    The person looking at the dropdown is the person who cloned the missing
//    repo, and a silently shorter list is indistinguishable from a box that lost
//    it — so every held-back project carries its reason and the surface shows
//    them.
//
// 3. FAILING TO ASK BECOMES FAILING CLOSED. Signed out, offline, or an org
//    server having a bad afternoon must widen the list, not empty it. A filter
//    that fails closed shows an empty machine to somebody whose wifi dropped,
//    and the only thing they can conclude is that their work is gone.

import { describe, expect, test } from "bun:test";

import type { PlaceProjects } from "../src/lib/api";
import {
  UNREAD,
  isUnnarrowed,
  projectsNotice,
  whyNotOffered,
  withheldProjects,
} from "../src/lib/place";
import { readSrc, stripComments } from "./support/code";

const TAURI = `${import.meta.dir}/../src-tauri/src`;

const rust = async (rel: string) =>
  stripComments(await Bun.file(`${TAURI}/${rel}`).text());

/** What the backend hands back for a runner two orgs share: one project each,
 *  read as a member of the first. */
const SHARED_RUNNER: PlaceProjects = {
  org: "naridon",
  org_name: "Naridon",
  narrowed: true,
  projects: [
    { path: "/srv/alpha", name: "alpha", remote: "https://github.com/naridon/alpha.git", branch: "main", dirty: 0 },
  ],
  withheld: [
    {
      path: "/srv/beta",
      name: "beta",
      reason: "mhask/beta belongs to mhask team, not Naridon.",
    },
  ],
  notice: "1 other project on this machine isn't Naridon's, so it isn't listed here.",
};

describe("the command narrows what the box found", () => {
  test("the discovery is still the box's, and still box-wide", async () => {
    // The whole design: `list_projects` is untouched and keeps scanning the
    // roots one level deep. A narrowing that edited the script would make the
    // repos it decided to hide invisible to the branch cache and to every
    // future question about the machine, too.
    const script = await rust("cloudbox/script.rs");
    expect(script).toContain("pub fn list_projects()");
    expect(script).toContain("project_roots()");
    // Nothing in the discovery has heard of an org.
    expect(script).not.toContain("org_slug");
  });

  test("box_projects narrows before it answers", async () => {
    const src = await rust("cloudbox/mod.rs");
    expect(src).toContain("place_projects::narrow(");
    expect(src).toContain("org_index()");
    // And the branch cache still reads the projects the box HOLDS, so an org
    // filter cannot make the rail forget which branch is checked out in the
    // machine's own repo directory.
    const found = src.indexOf("let found = place.projects().await?");
    const remembered = src.indexOf("remember_branch(&machine_id, &found)");
    const narrowed = src.indexOf("place_projects::narrow(");
    expect(found).toBeGreaterThan(-1);
    expect(remembered).toBeGreaterThan(found);
    expect(narrowed).toBeGreaterThan(remembered);
  });

  test("the org's registry is the cross-org read, not an org-scoped one", async () => {
    // `/orgs/{slug}/…` can only answer about an org you already named, so a
    // scoped call would leave "belongs to mhask" indistinguishable from
    // "belongs to nobody" — and the reason beside a held-back project is the
    // whole point of holding it back visibly.
    const src = await rust("manager/brain/place_projects.rs");
    expect(src).toContain("visible_repos()");
    const orgs = await rust("cmd_cloud_orgs.rs");
    expect(orgs).toContain("pub(crate) async fn visible_repos()");
  });

  test("one parser decides which repo a remote is, on either disk", async () => {
    // A checkout on this laptop is filed by reading `.git/config`; a checkout
    // on a box is filed by reading the remote the listing already carried. Two
    // parsers would eventually disagree about which org a project belongs to,
    // and the disagreement would be invisible.
    const sync = await rust("cloud_session_sync.rs");
    expect(sync).toContain("pub(crate) fn repo_full_name_of_url");
    const projects = await rust("manager/brain/place_projects.rs");
    expect(projects).toContain("repo_full_name_of_url(url)");
  });
});

describe("every surface reads the narrowed list", () => {
  test("the api seam hands back the whole answer", async () => {
    const src = await readSrc("lib/api.ts");
    expect(src).toContain('invoke<PlaceProjects>("box_projects"');
    // The old shape. A caller still typed to it would be a caller that never
    // sees `withheld`, and TypeScript is the only thing that catches it.
    expect(src).not.toContain('invoke<BoxProject[]>("box_projects"');
  });

  test("the box hook carries the reasons beside the list", async () => {
    const src = await readSrc("components/cloud/useBox.ts");
    expect(src).toContain("offered: PlaceProjects");
    // Null still means "nobody has asked yet / the read failed" — the same
    // promise `sessions` makes, so no caller invents an empty list.
    expect(src).toContain("projects: offered ? offered.projects : null");
    expect(src).toContain("offered: offered ?? UNREAD");
  });

  test("the picker draws the notice and what was left out", async () => {
    const src = await readSrc("components/cloud/BoxPanel.tsx");
    expect(src).toContain("WithheldNote");
    expect(src).toContain("projectsNotice(offered)");
    expect(src).toContain("withheldProjects(offered)");
    // Both states: a clean filter, and a list that could not be narrowed.
    expect(src).toContain("isUnnarrowed(offered)");
  });

  test("an empty picker says which kind of empty it is", async () => {
    // "This machine has no projects" and "none of the projects on this machine
    // are yours" look identical and mean opposite things — and only one of them
    // is answered by cloning something.
    const src = await readSrc("components/cloud/BoxPanel.tsx");
    expect(src).toContain("offered.withheld.length > 0");
    expect(src).toContain("None of the projects on this machine belong to the org");
  });

  test("the workspace composer repeats the reason rather than inventing one", async () => {
    // It used to say "doesn't have a copy of this yet", which would send
    // somebody to clone a repo that is sitting right there — and the clone
    // would land beside it under the same org that isn't theirs.
    const src = await readSrc("lib/workspaceCreateStore.ts");
    expect(src).toContain("offered.projects.find(");
    expect(src).toContain("whyNotOffered(offered, wanted)");
  });
});

describe("what a member of a shared runner actually reads", () => {
  test("only their org's project is on offer", () => {
    expect(SHARED_RUNNER.projects.map((p) => p.name)).toEqual(["alpha"]);
  });

  test("the other org's project is named, not merely missing", () => {
    const held = withheldProjects(SHARED_RUNNER);
    expect(held).toHaveLength(1);
    expect(held[0].name).toBe("beta");
    expect(held[0].reason).toContain("mhask team");
  });

  test("the sentence above the list says how many and whose", () => {
    expect(projectsNotice(SHARED_RUNNER)).toContain("isn't Naridon's");
  });

  test("asking after the missing project gets the reason, not a shrug", () => {
    // The one question this surface has to be able to answer: it's on the
    // machine, why isn't it in the dropdown?
    expect(whyNotOffered(SHARED_RUNNER, "beta")).toContain("mhask team");
    expect(whyNotOffered(SHARED_RUNNER, "alpha")).toBeNull();
  });

  test("a clean filter is not drawn as a warning", () => {
    expect(isUnnarrowed(SHARED_RUNNER)).toBe(false);
  });
});

describe("failing to ask widens the list, never empties it", () => {
  const offline: PlaceProjects = {
    ...SHARED_RUNNER,
    narrowed: false,
    projects: [
      ...SHARED_RUNNER.projects,
      { path: "/srv/beta", name: "beta", remote: "https://github.com/mhask/beta.git", branch: "main", dirty: 0 },
    ],
    withheld: [],
    notice:
      "Showing every project on this machine — Connection refused Sign in and reconnect to see only your org's.",
  };

  test("everything on the machine is still offered", () => {
    expect(offline.projects.map((p) => p.name)).toEqual(["alpha", "beta"]);
  });

  test("and it is drawn as a warning rather than as an ordinary filter", () => {
    expect(isUnnarrowed(offline)).toBe(true);
    expect(projectsNotice(offline)).toContain("Connection refused");
  });

  test("a place nobody has asked about yet is neither", () => {
    // The first frame of a slow read. A warning here would fire on every mount
    // of every panel.
    expect(isUnnarrowed(UNREAD)).toBe(false);
    expect(projectsNotice(UNREAD)).toBeNull();
    expect(UNREAD.projects).toEqual([]);
  });
});
