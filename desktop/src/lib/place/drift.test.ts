// A place reporting what it has against what the spec asks for.
//
// The claim under test is not "the types line up" — it is that somebody looking
// at two places can see WHY one of them works. So the cases here are the ones
// that decide whether the report is worth reading: a box deliberately behind its
// spec naming exactly what it is short of, a tool that is installed somewhere
// the work cannot see, and two reports reduced to the rows on which they differ.

import { describe, expect, test } from "bun:test";

import type { Drift, DriftItem } from "./drift";
import {
  alsoHere,
  blocking,
  compare,
  driftHeadline,
  driftTone,
  met,
  standingWord,
  trustWarning,
} from "./drift";

function item(over: Partial<DriftItem> & { id: string }): DriftItem {
  return {
    title: over.id.split(":").pop() ?? over.id,
    layer: "package",
    standing: "present",
    detail: "at spec",
    fix: null,
    ...over,
  };
}

/** A report in the shape the backend sends: worst news first. */
function report(over: Partial<Drift> = {}): Drift {
  const items = over.items ?? [];
  return {
    place: "aura-runner",
    spec_from: "aura-runner",
    version: 7,
    digest: "sha256:abc",
    trust: { state: "unsigned" },
    declares_environment: true,
    missing: items.filter((i) => i.standing === "missing").length,
    disputed: items.filter((i) => i.standing === "disputed").length,
    at_spec: !items.some(
      (i) => i.standing === "missing" || i.standing === "disputed",
    ),
    summary: "",
    ...over,
    items,
  };
}

/** A box short of most of what its project asked for. */
const BEHIND = report({
  items: [
    item({
      id: "runtime:tmux",
      layer: "runtime",
      standing: "missing",
      detail:
        "Without tmux nothing started here outlives its connection: close the lid or lose wifi and the session is gone rather than waiting for you.",
    }),
    item({
      id: "toolchain:node",
      title: "node 20.11.0",
      layer: "toolchain",
      standing: "missing",
      detail: "not here; `mise install node@20.11.0` would install it",
      fix: "mise install node@20.11.0",
    }),
    item({
      id: "package:brew/ripgrep",
      title: "ripgrep via brew",
      standing: "disputed",
      detail:
        "the spec's own check for `ripgrep` passes, but `command -v ripgrep` finds nothing — it is installed somewhere the work's own shell cannot see",
    }),
    item({ id: "runtime:git", layer: "runtime", detail: "`git` is here" }),
    item({
      id: "agent:claude",
      layer: "agent",
      standing: "unasked",
      detail: "`claude` is here and nothing declares it",
    }),
  ],
});

describe("a place behind its spec", () => {
  test("says exactly what is missing, and what would close it", () => {
    const short = blocking(BEHIND);
    expect(short.map((i) => i.id)).toEqual([
      "runtime:tmux",
      "toolchain:node",
      "package:brew/ripgrep",
    ]);
    // Naming a gap is only worth it if you are one step from closing it.
    expect(short[1].fix).toBe("mise install node@20.11.0");
  });

  test("a tool the work cannot see is neither present nor missing", () => {
    // The state that costs an afternoon: the package manager says yes and the
    // shell says no. Folding it into either answer throws away the only clue.
    const rg = BEHIND.items.find((i) => i.id === "package:brew/ripgrep")!;
    expect(rg.standing).toBe("disputed");
    expect(driftTone(rg.standing)).toBe("warn");
    expect(rg.detail).toContain("command -v ripgrep");
    expect(BEHIND.at_spec).toBe(false);
  });

  test("what it has that nobody declared is kept, not discarded", () => {
    // The half that makes this a diff rather than a checklist. Without it two
    // reports agree right up to the moment the work behaves differently.
    expect(alsoHere(BEHIND).map((i) => i.id)).toEqual(["agent:claude"]);
    expect(met(BEHIND).map((i) => i.id)).toEqual(["runtime:git"]);
    expect(standingWord("unasked")).toBe("here, undeclared");
  });

  test("the headline counts both kinds of trouble and names the version", () => {
    expect(driftHeadline(BEHIND)).toBe("Behind spec v7 — 2 missing, 1 in doubt");
    expect(driftHeadline(report({ items: [item({ id: "runtime:git" })] }))).toBe(
      "At spec v7",
    );
  });
});

describe("a project that declares no environment", () => {
  test("has nothing to be short of, and still says what the place has", () => {
    // Without this the feature would only work for projects that had already
    // adopted the spec — and the diff between two places is wanted most by the
    // ones that have not.
    const bare = report({
      declares_environment: true,
      items: [item({ id: "agent:codex", layer: "agent", standing: "unasked" })],
    });
    const nothing = { ...bare, declares_environment: false };
    expect(driftHeadline(nothing)).toBe(
      "This project declares no environment — below is what this place has",
    );
    expect(alsoHere(nothing)).toHaveLength(1);
    expect(blocking(nothing)).toEqual([]);
  });
});

describe("the seal on the spec", () => {
  test("interrupts only where somebody has to act", () => {
    // The commands in a spec are the ones a place runs unattended, and an
    // unreviewed edit is exactly the shape that arrives in.
    expect(trustWarning({ state: "stale", sealed: "a", actual: "b" })).toContain(
      "re-sign",
    );
    expect(trustWarning({ state: "invalid", detail: "bad signature" })).toContain(
      "bad signature",
    );
    expect(trustWarning({ state: "self_signed", key_id: "k" })).toContain(
      "publish it",
    );
    // And stays quiet where nothing is wrong: a warning nobody can act on is a
    // warning everybody learns to scroll past.
    expect(trustWarning({ state: "unsigned" })).toBeNull();
    expect(
      trustWarning({ state: "verified", key_id: "k", signer: "mo" }),
    ).toBeNull();
  });
});

describe("two places, side by side", () => {
  test("works-here-not-there comes back as the rows that differ", () => {
    // The whole point of the feature, and the reason ids are stable.
    const laptop = report({
      place: "This computer",
      items: [
        item({ id: "runtime:git", layer: "runtime" }),
        item({ id: "runtime:tmux", layer: "runtime" }),
        item({ id: "toolchain:node", title: "node 20.11.0", layer: "toolchain" }),
        item({ id: "agent:claude", layer: "agent", standing: "unasked" }),
      ],
    });
    const rows = compare(laptop, BEHIND);
    expect(rows.map((r) => r.id)).toEqual([
      "runtime:tmux",
      "toolchain:node",
      "package:brew/ripgrep",
    ]);

    // Each row carries both readings, so it says which way round it is.
    expect(rows[0].left!.standing).toBe("present");
    expect(rows[0].right!.standing).toBe("missing");

    // A line only one of them has at all is a difference too — and it is the
    // commonest one.
    expect(rows[2].left).toBeNull();
    expect(rows[2].right!.standing).toBe("disputed");
  });

  test("two reads of one place are not a difference", () => {
    expect(compare(BEHIND, BEHIND)).toEqual([]);
  });
});
