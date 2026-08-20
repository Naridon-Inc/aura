// One machine list, two sources — and the book still private.
//
//   bun test
//
// The Machines section used to draw `machines_list`: the `0600` address book on
// this laptop, and nothing else. A member whose admin had given them a box on
// the org's runner board saw an empty list here and had to be told in Slack
// that a machine existed; a box you had connected yourself and a box the whole
// team is on rendered as the same grey row.
//
// `places_list` merges the two at READ time. The three things that can quietly
// come undone are pinned here, because each of them fails silently:
//
// 1. THE SECTION GOES BACK TO ONE SOURCE. A later edit reaches for
//    `api.machinesList()` — it still compiles, still draws rows, and the org
//    half just stops appearing. Nothing throws. Only a scan catches it.
//
// 2. THE BOOK GETS SYNCED OR LOOSENED. The whole reason the merge is at read
//    time is that the book stays exactly as private as it was: it is not pushed
//    anywhere to make the org's rows joinable, and its mode is not widened to
//    make it readable by something else. A future "just cache the org rows into
//    the book" is a one-line change that turns a local secret into a synced
//    one, and a dropped `harden` call leaves the file at the umask.
//
// 3. THE TWO SOURCES STOP READING DIFFERENTLY. If every row says the same
//    thing, the merge has cost a screen and bought nothing — the point is that
//    a member with both kinds sees which is which and what they may do.
//
// The merge itself is proved on the Rust side (`place_roster::roster`, 13
// cases). What is checked here is the seam around it: what the surface asks
// for, what the backend is allowed to touch, and what a member with one of each
// actually reads.

import { describe, expect, test } from "bun:test";

import type { Machine, PlaceOrgHalf, PlaceRoster, PlaceRow } from "../src/lib/api";
import {
  addedByLine,
  ownerLine,
  rosterEntries,
} from "../src/lib/place";
import { readSrc, stripComments } from "./support/code";

const TAURI = `${import.meta.dir}/../src-tauri/src`;

/** A Rust file under `src-tauri/src`, comments removed. The comments in these
 *  files name the exact things they promise NOT to do, so a scan that reads
 *  them finds every forbidden call spelled out in prose. */
const rust = async (rel: string) =>
  stripComments(await Bun.file(`${TAURI}/${rel}`).text());

describe("the section asks for the merged list, not the book", () => {
  const section = () =>
    readSrc("components/workspaces/WorkspacesMachinesSection.tsx");

  test("it reads places_list", async () => {
    const src = await section();
    expect(src).toContain("placesList");
    // The old call. Left in place elsewhere — the connect wizard still needs
    // the book alone — but a list that asks for it here is a list with the org
    // half missing and no error to say so.
    expect(src).not.toContain("machinesList");
  });

  test("not-asked-yet is drawn as its own state", async () => {
    // The failure this catches: `roster?.places ?? []` rendered straight into
    // the empty state, so the first frame of a slow read tells somebody with
    // four machines that they have none.
    const src = await section();
    expect(src).toContain("LoadingState");
    expect(src).toContain("roster === null ?");
  });

  test("empty and unreachable are different sentences", async () => {
    const src = await section();
    expect(src).toContain("EmptyState");
    // Both come from the seam, so the wording is decided once and cannot drift
    // between this list and any other that grows later.
    expect(src).toContain("emptyLine(roster.org)");
    expect(src).toContain("orgNotice");
  });

  test("the org's failure is drawn above the rows, never instead of them", async () => {
    // A cloud that is down costs you the org half. The boxes on this laptop are
    // a file on this disk and are still reachable, so replacing the list with
    // an error would hide working machines because of a server they don't need.
    const src = await section();
    const notice = src.indexOf("ErrorNote");
    const rows = src.indexOf("places.map(");
    expect(notice).toBeGreaterThan(-1);
    expect(rows).toBeGreaterThan(notice);
    // And the rows are not inside the notice's branch.
    expect(src).not.toContain("notice ? (");
  });
});

describe("the book is neither synced nor weakened", () => {
  const FILES = ["place_roster/mod.rs", "place_roster/roster.rs", "place_roster/members.rs"];

  test("nothing in the merge writes the book", async () => {
    for (const rel of FILES) {
      const src = await rust(rel);
      for (const verb of [
        "write_book",
        "machine_save",
        "machine_forget",
        "fs::write",
        "File::create",
        "OpenOptions",
      ]) {
        expect(`${rel}: ${src.includes(verb)}`).toBe(`${rel}: false`);
      }
    }
  });

  test("nothing in the merge changes what the book is allowed to be read by", async () => {
    for (const rel of FILES) {
      const src = await rust(rel);
      expect(src).not.toContain("set_permissions");
      expect(src).not.toContain("from_mode");
    }
  });

  test("nothing in the merge pushes the book anywhere", async () => {
    // The shape of the mistake: "the server could match these for us if it had
    // the local rows". It could — and the book would stop being local.
    for (const rel of FILES) {
      const src = await rust(rel);
      for (const sink of [
        "live_sync_push",
        "sync_push",
        ".post(",
        "machines.json",
      ]) {
        expect(`${rel}: ${src.includes(sink)}`).toBe(`${rel}: false`);
      }
    }
  });

  test("the book is still shut to everyone but its owner when written", async () => {
    // The other half of "not weakened": the write path still hardens. A
    // `set_permissions` that quietly disappears leaves the file at whatever the
    // umask says, which on a shared box is world-readable.
    const src = await rust("cmd_machines.rs");
    expect(src).toContain("fn harden(");
    expect(src).toContain("from_mode(0o600)");
    // Called from the write, not merely defined. A helper nobody invokes is the
    // same file with worse permissions and a comforting function in it.
    const write = src.slice(src.indexOf("fn write_book("));
    expect(write.slice(0, write.indexOf("\n}\n"))).toContain("harden(&path)");
  });

  test("an org row carries no address, because there isn't one to carry", async () => {
    const src = await rust("place_roster/roster.rs");
    // The org's registry has no host, login or key path in it at all. The trap
    // is filling the gap from somewhere plausible — the book row of a
    // same-named box, an org default — so that a row for a machine you have
    // never connected acquires an address that ssh will happily try.
    const loop = src.indexOf("for runner in orphans {");
    expect(loop).toBeGreaterThan(-1);
    const built = src.slice(loop, src.indexOf("\n    }\n", loop));
    expect(built).toContain("machine: None");
    // And the only row that gets a `Machine` is the one a book entry was found
    // for — one construction site, not two.
    expect(src.split("machine: Some(").length - 1).toBe(1);
  });
});

describe("a member with both kinds reads which is which", () => {
  const org: PlaceOrgHalf = {
    status: "ok",
    detail: "",
    slug: "naridon",
    name: "Naridon",
    my_role: "member",
  };

  function machine(over: Partial<Machine> = {}): Machine {
    return {
      id: "ubuntu@10.0.0.9:/srv/beta",
      name: "my-laptop-box",
      host: "10.0.0.9",
      user: "ubuntu",
      key_path: "/Users/me/.ssh/aura.pem",
      box_kind: "mine",
      repo_path: "/srv/beta",
      project_root: "/Users/me/beta",
      repo_branch: "main",
      added_at: 1_750_000_000,
      last_used_at: 1_750_003_600,
      ...over,
    };
  }

  /** What `places_list` returns for someone who has one box of their own and
   *  one their org gave them: the shape the whole feature exists for. */
  const roster: PlaceRoster = {
    org,
    places: [
      {
        id: "ubuntu@10.0.0.9:/srv/beta",
        name: "my-laptop-box",
        source: "mine",
        owner: { kind: "you", label: "You", org_slug: null },
        added_by: { label: "you", is_you: true },
        may: {
          open: true,
          edit: true,
          forget: true,
          connect: false,
          summary: "Open it, change its address, or forget it — it is yours alone.",
        },
        machine: machine(),
        runner_id: null,
        online: null,
        agents: [],
        added_at: 1_750_000_000,
        last_used_at: 1_750_003_600,
      },
      {
        id: "runner:r7",
        name: "naridon-builder",
        source: "org",
        owner: { kind: "org", label: "Naridon", org_slug: "naridon" },
        added_by: { label: "@ana", is_you: false },
        may: {
          open: false,
          edit: false,
          forget: false,
          connect: true,
          summary:
            "Connect it to open a workspace — this laptop has no address for it yet.",
        },
        machine: null,
        runner_id: "r7",
        online: true,
        agents: ["claude"],
        added_at: 1_750_000_500,
        last_used_at: 0,
      },
    ],
  };

  test("both are on the one list", () => {
    expect(rosterEntries(roster).map((e) => e.row.name)).toEqual([
      "my-laptop-box",
      "naridon-builder",
    ]);
  });

  test("each row says whose it is and who put it there", () => {
    const said = roster.places.map(
      (row) => `${ownerLine(row)} · ${addedByLine(row)}`,
    );
    expect(said).toEqual([
      "Yours · Added by you",
      "Naridon's — not connected here · Added by @ana",
    ]);
    // The thing a list of names could not tell you.
    expect(said[0]).not.toBe(said[1]);
  });

  test("only the one this laptop has an address for is somewhere to open", () => {
    const [mine, theirs] = rosterEntries(roster);
    expect(mine.place?.identity.host).toBe("10.0.0.9");
    expect(theirs.place).toBeNull();
    expect(theirs.row.may.connect).toBe(true);
  });

  test("the org row it never connected holds no address of any kind", () => {
    // The privacy claim, read off the value the surface actually receives: an
    // org place we have not connected has no host, no login and no key path,
    // because the registry never had them and nothing here invented them.
    const theirs: PlaceRow = roster.places[1]!;
    const wire = JSON.stringify(theirs);
    expect(wire).not.toContain("key_path");
    expect(wire).not.toContain("10.0.0");
    expect(theirs.machine).toBeNull();
  });
});
