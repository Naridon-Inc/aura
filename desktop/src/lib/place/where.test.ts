// The two product rules, argued directly.
//
// Everything else in this file is scaffolding around them: a project's own
// cloud is offered only where it exists, a personal box is offered everywhere,
// and neither of those can put a row on screen that has nowhere to dial.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Machine, PlaceOrgHalf, PlaceRoster, PlaceRow } from "../api";
import { HERE, chosenWhere, whereOptions } from "./where";

const ALPHA = "/Users/me/alpha";
const BETA = "/Users/me/beta";

const NARIDON: PlaceOrgHalf = {
  status: "ok",
  detail: "",
  slug: "naridon",
  name: "Naridon",
  my_role: "member",
};

function box(over: Partial<Machine> = {}): Machine {
  return {
    id: "ubuntu@10.0.0.4:/srv/alpha",
    name: "team-box",
    host: "10.0.0.4",
    user: "ubuntu",
    key_path: "/Users/me/.ssh/aura.pem",
    box_kind: "shared",
    repo_path: "/srv/alpha",
    project_root: ALPHA,
    repo_branch: "main",
    added_at: 1_750_000_000,
    last_used_at: 1_750_003_600,
    ...over,
  };
}

/** The org's machine, filed under alpha and reachable from this laptop. */
function orgRow(over: Partial<PlaceRow> = {}): PlaceRow {
  return {
    id: "ubuntu@10.0.0.4:/srv/alpha",
    name: "team-box",
    source: "both",
    owner: { kind: "org", label: "Naridon", org_slug: "naridon" },
    added_by: { label: "@ana", is_you: false },
    may: { open: true, edit: true, forget: true, connect: false, summary: "Open it." },
    machine: box(),
    runner_id: "r1",
    online: true,
    agents: ["claude"],
    added_at: 1_750_000_000,
    last_used_at: 1_750_003_600,
    ...over,
  };
}

/** A box you brought, filed under nothing in particular. */
function myRow(over: Partial<PlaceRow> = {}): PlaceRow {
  return orgRow({
    id: "mo@10.0.0.9:/home/mo/beta",
    name: "my-box",
    source: "mine",
    owner: { kind: "you", label: "You", org_slug: null },
    added_by: { label: "you", is_you: true },
    runner_id: null,
    online: null,
    agents: [],
    machine: box({
      id: "mo@10.0.0.9:/home/mo/beta",
      name: "my-box",
      host: "10.0.0.9",
      user: "mo",
      box_kind: "mine",
      repo_path: "/home/mo/beta",
      project_root: BETA,
    }),
    ...over,
  });
}

function roster(places: PlaceRow[]): PlaceRoster {
  return { places, org: NARIDON };
}

describe("the Where question", () => {
  test("this laptop is always the first answer, and always an answer", () => {
    // Signed out, offline, no book at all — the local option cannot be
    // unreachable, and a list whose first row is a machine makes the common
    // answer the one you have to hunt for.
    const options = whereOptions(null, ALPHA, "Alpha");
    expect(options).toHaveLength(1);
    expect(options[0].id).toBe(HERE);
    expect(options[0].label).toBe("This laptop");
    expect(options[0].machineId).toBeNull();
  });

  test("a project with no cloud and no box of yours offers only this laptop", () => {
    // The acceptance criterion in one line: no dead rows, no disabled rows,
    // nothing to explain away.
    const options = whereOptions(roster([]), ALPHA, "Alpha");
    expect(options.map((o) => o.label)).toEqual(["This laptop"]);
  });

  test("rule 1 — the project's cloud appears on the project that has one", () => {
    const options = whereOptions(roster([orgRow()]), ALPHA, "Alpha");
    const cloud = options.find((o) => o.kind === "project-cloud");
    expect(cloud?.label).toBe("Alpha's cloud");
    // Named in plain words, and the machine it actually is says so underneath
    // rather than in the label.
    expect(cloud?.detail).toContain("team-box");
    expect(cloud?.machineId).toBe("ubuntu@10.0.0.4:/srv/alpha");
    // Where the project sits over there, so the launch doesn't have to ask.
    expect(cloud?.projectPath).toBe("/srv/alpha");
  });

  test("rule 1 — the org's machine for another project is not offered here", () => {
    // Standing in beta, Naridon's alpha box is neither beta's cloud nor a box
    // of yours. Offering it would be a row whose only outcome is a failure.
    const options = whereOptions(roster([orgRow()]), BETA, "Beta");
    expect(options.map((o) => o.label)).toEqual(["This laptop"]);
  });

  test("rule 1 — an org place this laptop cannot dial is never a row", () => {
    // No address: `may.connect` is the honest verb for it, and that lives on
    // the fleet list. A picker that offered it would be offering a failure.
    const options = whereOptions(
      roster([orgRow({ id: "runner:r9", machine: null, may: { open: false, edit: false, forget: false, connect: true, summary: "Connect it." } })]),
      ALPHA,
      "Alpha",
    );
    expect(options.map((o) => o.label)).toEqual(["This laptop"]);
  });

  test("rule 2 — your own box is offered on a project it was never filed under", () => {
    // It belongs to you, not to the repo. This is the whole of rule 2: my-box
    // is filed under beta and is still on offer from alpha.
    const options = whereOptions(roster([myRow()]), ALPHA, "Alpha");
    const mine = options.find((o) => o.kind === "my-box");
    expect(mine?.label).toBe("my-box");
    expect(mine?.detail).toBe("Yours");
    expect(mine?.machineId).toBe("mo@10.0.0.9:/home/mo/beta");
  });

  test("rule 2 — and on every other project too", () => {
    for (const root of [ALPHA, BETA, "/Users/me/gamma", null]) {
      const options = whereOptions(roster([myRow()]), root, "Whatever");
      expect(options.some((o) => o.machineId === "mo@10.0.0.9:/home/mo/beta")).toBe(true);
    }
  });

  test("your own box, standing in the project it holds, is that project's cloud", () => {
    // Same machine, different sentence. From beta it IS beta's cloud, and
    // calling it "my-box" there would make the person work out which of their
    // machines has this project on it.
    const options = whereOptions(roster([myRow()]), BETA, "Beta");
    const cloud = options.find((o) => o.kind === "project-cloud");
    expect(cloud?.label).toBe("Beta's cloud");
    expect(cloud?.projectPath).toBe("/home/mo/beta");
  });

  test("a trailing slash in the book is punctuation, not a different project", () => {
    // The book is hand-editable and the wizard writes what it was given.
    const row = myRow({ machine: box({ id: "m", project_root: `${ALPHA}/` }) });
    const options = whereOptions(roster([row]), ALPHA, "Alpha");
    expect(options.find((o) => o.machineId === "m")?.kind).toBe("project-cloud");
  });

  test("a place with no recorded directory says so rather than guessing one", () => {
    // `null` here means the launch asks the box which projects it holds. A
    // plausible path invented here would be a directory the box has never seen.
    const row = myRow({ machine: box({ id: "m", repo_path: null, project_root: null }) });
    const options = whereOptions(roster([row]), ALPHA, "Alpha");
    expect(options.find((o) => o.machineId === "m")?.projectPath).toBeNull();
  });

  test("a remembered choice that has gone falls back to this laptop", () => {
    // A forgotten box must not leave a surface holding an id nobody can reach:
    // the next launch would name a machine that isn't there.
    const options = whereOptions(roster([myRow()]), ALPHA, "Alpha");
    expect(chosenWhere(options, "mo@10.0.0.9:/home/mo/beta").kind).toBe("my-box");
    expect(chosenWhere(options, "a-box-you-forgot").id).toBe(HERE);
    expect(chosenWhere(options, null).id).toBe(HERE);
  });

  test("the book's order survives — most recently used leads", () => {
    // That order is the answer to "which one did you mean", and re-sorting it
    // here would put this surface's opinion above the one the whole app shares.
    const a = myRow({ id: "a", name: "a", machine: box({ id: "a", project_root: null }) });
    const b = myRow({ id: "b", name: "b", machine: box({ id: "b", project_root: null }) });
    const options = whereOptions(roster([a, b]), ALPHA, "Alpha");
    expect(options.map((o) => o.id)).toEqual([HERE, "a", "b"]);
  });
});

// ── Both doors ask it ────────────────────────────────────────────────────────
//
// The rules above can be right and the product still wrong, in the one way this
// task exists to fix: a surface that starts work without asking. These read the
// two surfaces themselves, because "the same Where row appears wherever new
// work starts" is a fact about which files mount the control, and nothing in a
// pure function can hold it.

const SURFACES = [
  ["the New-workspace dialog", "../../components/workspace/WorkspaceCreateComposer.tsx"],
  ["the launcher a new chat starts from", "../../components/launcher/Launcher.tsx"],
] as const;

describe("wherever new work starts", () => {
  for (const [what, file] of SURFACES) {
    test(`${what} asks where it runs, through the one control`, () => {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      // The hook, so the rows come from `whereOptions` and this surface cannot
      // have its own opinion about which places exist.
      expect(source).toContain("useWherePlaces(");
      // And the control, so the question looks and reads the same in both.
      expect(source).toContain("<WherePicker");
    });

    test(`${what} sends the chosen machine on, rather than dropping it`, () => {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      // A picker whose answer never reaches a call is a control that lies. Both
      // surfaces have to carry the machine into whatever they start.
      expect(source).toMatch(/machineId/);
    });
  }
});
