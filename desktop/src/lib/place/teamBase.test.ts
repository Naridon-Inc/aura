import { describe, expect, mock, test } from "bun:test";

import type { BaseBuild, Held, TeamBase, WarmStart } from "./teamBase";

type BaseAsk = { root: string | null; machineId: string | null };
type WarmAsk = {
  place: { root: string | null; machineId: string | null };
  login?: string;
  force: boolean;
};

const baseAsks: BaseAsk[] = [];
const warmAsks: WarmAsk[] = [];

const CARGO: Held = {
  under: ".cargo",
  tool: "cargo",
  holds: "downloaded crates and compiled build artefacts",
};
const RUSTUP: Held = {
  under: ".rustup",
  tool: "rustup",
  holds: "installed rust toolchains",
};
const NPM: Held = {
  under: ".npm",
  tool: "npm",
  holds: "downloaded node packages",
};

let baseAnswer: TeamBase = {
  place: "aura-runner",
  login: "aura-base",
  home: "/home/aura-base",
  created: false,
  shared: true,
  readable: true,
  scoped: true,
  holds: [CARGO, RUSTUP],
  carries: [],
  built_version: 4,
  built_digest: "sha256:abcd",
};

let warmAnswer: BaseBuild = {
  base: baseAnswer,
  already_built: true,
  report: null,
  start: {
    member: "mo",
    home: "/home/mo",
    from: "aura-base",
    alone: false,
    seeded: [CARGO, RUSTUP],
    kept: [],
    missing: [],
    failed: [],
    refused: "",
    warm: true,
  },
};

mock.module("../api", () => ({
  api: {
    placeTeamBase: (place: { root: string | null; machineId: string | null }) => {
      baseAsks.push({ ...place });
      return Promise.resolve(baseAnswer);
    },
    placeTeamBaseWarm: (
      place: { root: string | null; machineId: string | null },
      login: string | undefined,
      force: boolean,
    ) => {
      warmAsks.push({ place, login, force });
      return Promise.resolve(warmAnswer);
    },
  },
}));

const {
  askTeamBase,
  baseIsUsable,
  baseWarning,
  baseWasBuilt,
  warmSentence,
  warmShortfall,
  warmStart,
} = await import("./teamBase");

const place = (machineId: string | null) =>
  ({
    kind: machineId ? ("box" as const) : ("here" as const),
    machineId,
    identity: { host: machineId ? "box.example" : null, user: "mo", kind: "ssh" },
    project: { root: "/Users/mo/code/aura", name: "aura" },
    capabilities: { agents: [], git: true, tmux: true, aura: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

/** A base with one thing changed. */
const baseWith = (over: Partial<TeamBase>): TeamBase => ({ ...baseAnswer, ...over });

/** A join with one thing changed. */
const startWith = (over: Partial<WarmStart>): BaseBuild => ({
  ...warmAnswer,
  start: { ...warmAnswer.start, ...over },
});

describe("starting from the team's environment", () => {
  test("the ask reaches the place, on both place-modes", async () => {
    // The governing rule on this side: one call shape, so a warm start cannot
    // be arranged for one way of getting a place and not the other.
    baseAsks.length = 0;
    warmAsks.length = 0;
    await askTeamBase(place(null));
    await askTeamBase(place("box-1"));
    expect(baseAsks).toHaveLength(2);
    expect(baseAsks[0].machineId).toBeNull();
    expect(baseAsks[1].machineId).toBe("box-1");
    for (const a of baseAsks) expect(a.root).toBe("/Users/mo/code/aura");

    await warmStart(place("box-1"), "mo");
    expect(warmAsks).toHaveLength(1);
    expect(warmAsks[0].place.machineId).toBe("box-1");
    expect(warmAsks[0].login).toBe("mo");
    // Not forced unless somebody asked for it: forcing applies a spec whose
    // seal did not check out, which is not a default.
    expect(warmAsks[0].force).toBe(false);
  });

  test("a base holding somebody's credential is not one to start from", () => {
    // The one failure worse than a slow install. Everything else here is about
    // minutes; this is about a member's home ending up with a teammate's token
    // in it, which is the precise thing the private home exists to prevent.
    const carrying = baseWith({ carries: [".config/gh"] });
    expect(baseIsUsable(carrying)).toBe(false);
    const warning = baseWarning(carrying);
    expect(warning).toContain(".config/gh");
    expect(warning).toContain("never credentials");
  });

  test("a base nobody can read, and one that installed into the machine, both refuse", () => {
    // They fail differently and read differently. Unreadable fails one member
    // at a time; unscoped comes up empty however many times the spec is applied
    // to it, which looks like a base that was never built rather than a broken
    // one.
    expect(baseIsUsable(baseWith({ readable: false }))).toBe(false);
    expect(baseWarning(baseWith({ readable: false }))).toContain("cannot be read");
    expect(baseIsUsable(baseWith({ scoped: false }))).toBe(false);
    expect(baseWarning(baseWith({ scoped: false }))).toContain("into the machine");
    // And a base with none of those wrong says nothing, rather than something
    // reassuring nobody asked for.
    expect(baseIsUsable(baseAnswer)).toBe(true);
    expect(baseWarning(baseAnswer)).toBeNull();
  });

  test("built is a fact about a spec, not about an account existing", () => {
    // An account that exists and holds nothing is what the FIRST member finds,
    // and reading it as built would tell them their install already happened.
    expect(baseWasBuilt(baseAnswer)).toBe(true);
    expect(baseWasBuilt(baseWith({ built_version: 0, built_digest: "" }))).toBe(false);
    expect(baseWasBuilt(baseWith({ built_digest: "" }))).toBe(false);
  });

  test("the second member is told they installed nothing", () => {
    // The claim the whole feature is judged on, put in words. A surface that
    // said only "ready" would have hidden the one number that makes a shared
    // box worth having.
    const said = warmSentence(warmAnswer);
    expect(said).toContain("already built to this spec");
    expect(said).toContain("nothing was installed");
    expect(said).toContain("downloaded crates");
  });

  test("the first member is told the next person will not pay for it", () => {
    const said = warmSentence({ ...warmAnswer, already_built: false });
    expect(said).toContain("brought to the project's spec");
    expect(said).toContain("pays none of that");
  });

  test("one member on a place is standing in it already", () => {
    // This laptop, and a box with one account on it. Not an error and not an
    // apology: it is the right answer to "where is the team's environment here".
    const said = warmSentence(startWith({ alone: true, seeded: [], warm: false }));
    expect(said).toContain("One person works on");
    expect(said).toContain("already standing in it");
  });

  test("a refusal is repeated rather than dressed up as a warm start", () => {
    const said = warmSentence(
      startWith({
        seeded: [],
        warm: false,
        refused: "the team's environment is holding .ssh",
      }),
    );
    expect(said).toContain("Nothing was copied");
    expect(said).toContain(".ssh");
  });

  test("a copy that half-failed says so, apart from the good news", () => {
    // These fail apart, so they are said apart. A member whose home looks warm
    // and is short finds out in the middle of a build otherwise.
    expect(warmShortfall(warmAnswer.start)).toBeNull();
    const short = warmShortfall({ ...warmAnswer.start, failed: [".rustup"] });
    expect(short).toContain(".rustup");
    expect(short).toContain("downloaded again");
  });

  test("what came across is said in words rather than as paths", () => {
    // The list a person reads is what each thing HOLDS, because ".npm" tells
    // somebody nothing about why waiting for it again would have hurt.
    const three = warmSentence(
      startWith({ seeded: [CARGO, RUSTUP, NPM] }),
    );
    expect(three).toContain("3 things");
    expect(three).toContain("downloaded crates and compiled build artefacts");
    expect(three).toContain("and downloaded node packages");
    const one = warmSentence(startWith({ seeded: [NPM] }));
    expect(one).toContain("One thing");
  });

  test("a member who already had something is not told it was replaced", () => {
    // Never overwritten: a member who pinned their own toolchain keeps it, and
    // the sentence must not claim otherwise.
    const said = warmSentence(
      startWith({ seeded: [], kept: [".rustup", ".cargo"], missing: [] }),
    );
    expect(said).toContain("already had everything it holds");
    expect(said).not.toContain("came across");
  });
});
