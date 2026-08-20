import { describe, expect, test } from "bun:test";

import type { Machine } from "../api";
import {
  placeHere,
  placeOfMachine,
  placesOfMachines,
  placeAddress,
} from "./contract";
import { filePlaces, placeRowLabel, projectToFilePlaceUnder } from "./placement";

function box(over: Partial<Machine> = {}): Machine {
  return {
    id: "ubuntu@10.0.0.1",
    name: "aura-runner",
    host: "10.0.0.1",
    user: "ubuntu",
    key_path: "/keys/aura.pem",
    box_kind: "mine",
    repo_path: "/home/ubuntu/aura-src",
    project_root: null,
    repo_branch: null,
    added_at: 1,
    last_used_at: 2,
    ...over,
  };
}

/** A place straight off a book row — the state every rail row is drawn from. */
const place = (over: Partial<Machine> = {}) => placeOfMachine(box(over));

const NEW_GIT = "/Users/me/Documents/New Git";
const NARIDON = "/Users/me/code/naridon";

describe("reading a machine book row as a place", () => {
  test("nothing is invented on the way", () => {
    expect(place({ project_root: NEW_GIT, repo_branch: "main" })).toEqual({
      machineId: "ubuntu@10.0.0.1",
      name: "aura-runner",
      identity: {
        user: "ubuntu",
        host: "10.0.0.1",
        key_path: "/keys/aura.pem",
        kind: "mine",
        address: "ubuntu@10.0.0.1",
        // A row that carries no decision about lending your key reads as off.
        // Absent is not consent, and this is the assertion that says so.
        forward_agent: false,
      },
      project: {
        root: NEW_GIT,
        path: "/home/ubuntu/aura-src",
        branch: "main",
      },
      addedAt: 1,
      lastUsedAt: 2,
      // A row from a book written before Aura could stop a machine. Absent
      // means awake — reading the missing field as a timestamp would draw
      // every machine in the book as switched off.
      asleepSince: 0,
      // A row nobody granted Aura anything about, which is what a box you
      // brought is until its owner opens up the account it runs in.
      lifecycleHandle: null,
      capabilities: null,
    });
  });

  test("blank fields are absent, not blank", () => {
    // The book has hand-edited rows and wizard steps somebody tabbed past.
    // `"   "` filed as a project root is a place filed under a repo named
    // nothing, which is worse than an unfiled place.
    const p = place({ project_root: "   ", repo_branch: " ", repo_path: "" });
    expect(p.project).toEqual({ root: null, path: null, branch: null });
  });

  test("a kind this build has never heard of is a box you brought, not a drop", () => {
    // The address in that row is the only way back to that machine.
    expect(place({ box_kind: "tomorrows-kind" }).identity.kind).toBe("mine");
    expect(place({ box_kind: "shared" }).identity.kind).toBe("shared");
    expect(place({ box_kind: "managed" }).identity.kind).toBe("managed");
  });

  test("this laptop has no address and says so", () => {
    // Not "localhost" — a plausible invention is a value some later surface
    // tries to ssh to.
    const here = placeHere(NEW_GIT);
    expect(here.machineId).toBe(null);
    expect(here.identity.host).toBe(null);
    expect(here.identity.key_path).toBe(null);
    expect(here.identity.address).toBe(null);
    expect(here.identity.kind).toBe("here");
    expect(placeAddress(here)).toBe("");
  });

  test("the book's order is the answer to 'which one did you mean'", () => {
    const recent = box({ id: "ubuntu@a" });
    const older = box({ id: "ubuntu@b" });
    expect(placesOfMachines([recent, older]).map((p) => p.machineId)).toEqual([
      "ubuntu@a",
      "ubuntu@b",
    ]);
  });
});

describe("filing a place beside its project", () => {
  test("a place sits under the project it was connected for", () => {
    const p = place({ project_root: NEW_GIT });
    const { byProject, unplaced } = filePlaces([p], new Set([NEW_GIT]));
    expect(byProject.get(NEW_GIT)).toEqual([p]);
    expect(unplaced).toEqual([]);
  });

  test("two places for one project keep the order they came in", () => {
    // `machines_list` sorts by last used, and that order is the answer to
    // "which one did you mean" — the bucket must not resort it.
    const recent = place({ id: "ubuntu@a", project_root: NEW_GIT });
    const older = place({ id: "ubuntu@b", project_root: NEW_GIT });
    const { byProject } = filePlaces([recent, older], new Set([NEW_GIT]));
    expect(byProject.get(NEW_GIT)).toEqual([recent, older]);
  });

  test("places for different projects don't mix", () => {
    const a = place({ id: "ubuntu@a", project_root: NEW_GIT });
    const b = place({ id: "ubuntu@b", project_root: NARIDON });
    const { byProject } = filePlaces([a, b], new Set([NEW_GIT, NARIDON]));
    expect(byProject.get(NEW_GIT)).toEqual([a]);
    expect(byProject.get(NARIDON)).toEqual([b]);
  });

  test("a place that never named a project stands on its own", () => {
    // Every book written before the field existed is in this state. Filing it
    // under whichever project happens to be first would put a box under a repo
    // it has never seen.
    const p = place({ project_root: null });
    const { byProject, unplaced } = filePlaces([p], new Set([NEW_GIT]));
    expect(byProject.size).toBe(0);
    expect(unplaced).toEqual([p]);
  });

  test("blank is not a project", () => {
    const p = place({ project_root: "   " });
    const { unplaced } = filePlaces([p], new Set([NEW_GIT]));
    expect(unplaced).toEqual([p]);
  });

  test("a place for a project you closed is still shown, just unfiled", () => {
    // Dropping it would take the only address for that machine with it — the
    // book is the only place the host, login and key path live.
    const p = place({ project_root: NARIDON });
    const { byProject, unplaced } = filePlaces([p], new Set([NEW_GIT]));
    expect(byProject.size).toBe(0);
    expect(unplaced).toEqual([p]);
  });

  test("no places is not an error", () => {
    const { byProject, unplaced } = filePlaces([], new Set([NEW_GIT]));
    expect(byProject.size).toBe(0);
    expect(unplaced).toEqual([]);
  });

  test("this laptop files under its own project like anything else", () => {
    // The filing rule reads `project.root`, which every place has — so the day
    // a local place appears in that list it needs no second rule.
    const here = placeHere(NEW_GIT);
    const { byProject } = filePlaces([here], new Set([NEW_GIT]));
    expect(byProject.get(NEW_GIT)).toEqual([here]);
  });
});

describe("learning a place's project on the way in", () => {
  test("an unfiled place entered from a project gets filed there", () => {
    expect(projectToFilePlaceUnder(place(), NEW_GIT)).toBe(NEW_GIT);
  });

  test("a place that already knows its project is left alone", () => {
    // Otherwise its position in the rail would follow wherever you last came
    // from, and a place that moves is not a place.
    const p = place({ project_root: NEW_GIT });
    expect(projectToFilePlaceUnder(p, NARIDON)).toBe(null);
  });

  test("arriving from nowhere writes nothing", () => {
    expect(projectToFilePlaceUnder(place(), null)).toBe(null);
    expect(projectToFilePlaceUnder(place(), undefined)).toBe(null);
    expect(projectToFilePlaceUnder(place(), "  ")).toBe(null);
  });

  test("no place, nothing to file", () => {
    expect(projectToFilePlaceUnder(null, NEW_GIT)).toBe(null);
  });
});

// A rail full of rows called "aura-runner" tells you a computer exists. Under a
// project, what you want to know is which work is happening over there — the
// same question every other row in that list answers.
describe("what a place's row is called", () => {
  test("the branch checked out there is the row's name", () => {
    const p = place({ repo_branch: "feat/cloud-placement-plane" });
    expect(placeRowLabel(p)).toEqual({
      work: "feat/cloud-placement-plane",
      machine: "aura-runner",
    });
  });

  test("with no branch known, the checkout directory names it", () => {
    // The place has been connected but nothing has looked inside it yet. The
    // folder the project sits in is still a truer answer than the box's name.
    const p = place({ repo_branch: null, repo_path: "/home/ubuntu/naridon" });
    expect(placeRowLabel(p)).toEqual({ work: "naridon", machine: "aura-runner" });
  });

  test("a trailing slash doesn't produce an empty name", () => {
    const p = place({ repo_branch: null, repo_path: "/home/ubuntu/naridon/" });
    expect(placeRowLabel(p).work).toBe("naridon");
  });

  test("a place with nothing checked out says its own name, once", () => {
    // Not "aura-runner / aura-runner" — the second line is dropped rather than
    // repeating the first, which is why `machine` comes back empty.
    const p = place({ repo_branch: null, repo_path: null });
    expect(placeRowLabel(p)).toEqual({ work: "aura-runner", machine: "" });
  });

  test("whitespace is not a branch", () => {
    const p = place({ repo_branch: "   ", repo_path: "/home/ubuntu/aura-src" });
    expect(placeRowLabel(p).work).toBe("aura-src");
  });

  test("the address is never the label", () => {
    // An IP is unreadable at a glance and changes when the box restarts. It
    // belongs in the tooltip, and nowhere a row is scanned.
    const p = place({ repo_branch: "main" });
    const { work, machine } = placeRowLabel(p);
    expect(work).not.toContain("10.0.0.1");
    expect(machine).not.toContain("10.0.0.1");
  });
});
