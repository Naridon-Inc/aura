import { describe, expect, test } from "bun:test";

import type { Machine, PlaceOrgHalf, PlaceRoster, PlaceRow } from "../api";
import {
  addedByLine,
  emptyLine,
  orgNotice,
  ownerLine,
  placeOfRow,
  rosterEntries,
  rowTooltip,
} from "./roster";

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
    project_root: "/Users/me/alpha",
    repo_branch: "main",
    added_at: 1_750_000_000,
    last_used_at: 1_750_003_600,
    ...over,
  };
}

/** A row as the backend hands it over. The defaults are the `both` case — in
 *  the book and on the org's board — because that is the one every field of
 *  this type has something to say about. */
function row(over: Partial<PlaceRow> = {}): PlaceRow {
  return {
    id: "ubuntu@10.0.0.4:/srv/alpha",
    name: "team-box",
    source: "both",
    owner: { kind: "org", label: "Naridon", org_slug: "naridon" },
    added_by: { label: "@ana", is_you: false },
    may: {
      open: true,
      edit: true,
      forget: true,
      connect: false,
      summary:
        "Open it. Forgetting drops this laptop's address; the place stays on Naridon's board.",
    },
    machine: box(),
    runner_id: "r1",
    online: true,
    agents: ["claude"],
    added_at: 1_750_000_000,
    last_used_at: 1_750_003_600,
    ...over,
  };
}

const mine = () =>
  row({
    id: "ubuntu@10.0.0.9:/srv/beta",
    name: "my-box",
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
    machine: box({ id: "ubuntu@10.0.0.9:/srv/beta", name: "my-box" }),
    runner_id: null,
    online: null,
    agents: [],
  });

const theirs = () =>
  row({
    id: "runner:r2",
    name: "big-box",
    source: "org",
    may: {
      open: false,
      edit: false,
      forget: false,
      connect: true,
      summary:
        "Connect it to open a workspace — this laptop has no address for it yet.",
    },
    machine: null,
    runner_id: "r2",
  });

describe("a row is not always a place", () => {
  test("a row this laptop has an address for reads as the place it is", () => {
    const place = placeOfRow(row());
    expect(place?.machineId).toBe("ubuntu@10.0.0.4:/srv/alpha");
    expect(place?.identity.host).toBe("10.0.0.4");
    expect(place?.project.branch).toBe("main");
  });

  test("an org place with no address here is not a place, and is not THIS one", () => {
    // The trap this returns null to avoid: `machineId: null` means this laptop.
    // A box you have not connected rendered as `placeHere` would be a row that
    // opens a shell on the wrong computer.
    expect(placeOfRow(theirs())).toBeNull();
  });

  test("the board's agent list is not read as capabilities", () => {
    // Two different questions. The board says what a runner reported when it
    // registered; `capabilities` is what was read off the place, and it also
    // answers git, tmux and aura — which the board has never been asked. Three
    // fields of `false` is a machine's worst day presented as a survey.
    const place = placeOfRow(row({ agents: ["claude", "codex"] }));
    expect(place?.capabilities).toBeNull();
  });

  test("the order the backend sent is the order kept", () => {
    // That order is the answer to "which one did you mean": what you can enter,
    // most recently used first, then what you'd have to connect.
    const roster: PlaceRoster = {
      places: [mine(), row(), theirs()],
      org: NARIDON,
    };
    expect(rosterEntries(roster).map((e) => e.row.name)).toEqual([
      "my-box",
      "team-box",
      "big-box",
    ]);
    expect(rosterEntries(roster).map((e) => e.place !== null)).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe("whose it is, said on the row", () => {
  test("a box only your book knows is yours", () => {
    expect(ownerLine(mine())).toBe("Yours");
    expect(addedByLine(mine())).toBe("Added by you");
  });

  test("a box on the org's board says whose, and whether you can get in", () => {
    // The second clause is what stops two rows reading identically when one
    // opens on click and the other cannot — the exact state this list was
    // merged to make visible.
    expect(ownerLine(row())).toBe("Naridon's — you have the address");
    expect(ownerLine(theirs())).toBe("Naridon's — not connected here");
  });

  test("who added it is a name, never an id", () => {
    expect(addedByLine(row())).toBe("Added by @ana");
    expect(
      addedByLine(row({ added_by: { label: "someone in Naridon", is_you: false } })),
    ).toBe("Added by someone in Naridon");
  });

  test("nobody recorded is said, not guessed at", () => {
    expect(
      addedByLine(row({ added_by: { label: "not recorded", is_you: false } })),
    ).toBe("Who added it isn't recorded");
  });

  test("the tooltip says all three things, and takes the rights from the row", () => {
    // The sentence is the backend's own, so what the tooltip promises and which
    // buttons are enabled cannot say different things.
    const tip = rowTooltip(theirs());
    expect(tip).toContain("Naridon's — not connected here");
    expect(tip).toContain("Added by @ana");
    expect(tip).toContain(theirs().may.summary);
  });
});

describe("the org half says which of the three states it is in", () => {
  test("an answer is no notice at all", () => {
    expect(orgNotice(NARIDON)).toBeNull();
  });

  test("signed out is an invitation, not a failure", () => {
    const line = orgNotice({ ...NARIDON, status: "signed_out" });
    expect(line).toBe("Sign in to Aura Cloud to see the places your org has.");
  });

  test("unreachable keeps the server's own words", () => {
    // "Connection refused" says what to do next. "Something went wrong" sends
    // someone to support with nothing in their hand.
    const line = orgNotice({
      ...NARIDON,
      status: "unreachable",
      detail: "HTTP 503: upstream unavailable",
    });
    expect(line).toContain("Couldn't reach Naridon");
    expect(line).toContain("showing the boxes on this laptop");
    expect(line).toContain("HTTP 503: upstream unavailable");
  });

  test("a failure with nothing to add doesn't print an empty tail", () => {
    expect(orgNotice({ ...NARIDON, status: "unreachable", detail: "  " })).toBe(
      "Couldn't reach Naridon — showing the boxes on this laptop.",
    );
  });

  test("an org we can only name by slug is named by its slug", () => {
    expect(
      orgNotice({ ...NARIDON, status: "unreachable", name: null, detail: "" }),
    ).toContain("naridon");
  });

  test("an org with neither is still spoken about", () => {
    // A token with no org recorded yet is a real state, and "Couldn't reach"
    // followed by nothing is not a sentence.
    expect(
      orgNotice({
        status: "unreachable",
        detail: "",
        slug: null,
        name: null,
        my_role: null,
      }),
    ).toBe("Couldn't reach your org — showing the boxes on this laptop.");
  });
});

describe("empty means three different things", () => {
  test("an answered org with nothing in it says so, and says whose", () => {
    expect(emptyLine(NARIDON)).toBe("No machines yet — neither yours nor Naridon's.");
  });

  test("signed out claims nothing about an org it never asked", () => {
    expect(emptyLine({ ...NARIDON, status: "signed_out" })).toBe(
      "No machines on this laptop yet.",
    );
  });

  test("unreachable does not report a team's machines as absent", () => {
    // The one that would be a lie. "You have no machines" while the server that
    // knows about them is down is the app inventing an answer.
    const line = emptyLine({ ...NARIDON, status: "unreachable" });
    expect(line).toContain("couldn't be asked");
    expect(line).toContain("Naridon");
  });
});
