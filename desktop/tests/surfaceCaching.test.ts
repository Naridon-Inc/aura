// Seeding a surface from the last read is only safe if what got cached was a
// real answer. These pin the place where caching the wrong thing would
// quietly reintroduce a bug the code already carries a comment about.

import { describe, expect, it } from "bun:test";

import { readSrc, stripComments } from "./support/code";

const CREW = "components/commons/crew/CrewSurface.tsx";

describe("Mission Control remembers the board, not the banner", () => {
  it("caches the two reads that draw the work", async () => {
    const src = stripComments(await readSrc(CREW));
    expect(src).toContain("writeCache<CrewBoard>(boardKey, { view: v, proof: p })");
  });

  it("does not cache the review flags", async () => {
    // The flags drive a banner asking you to look at something. Restoring one
    // from a previous visit would pop a demand for attention on a surface that
    // has not actually checked yet.
    const src = stripComments(await readSrc(CREW));
    expect(src).not.toContain("flags: flags");
    expect(src).not.toContain("reviewFlags: flags");
    const type = src.slice(
      src.indexOf("type CrewBoard = "),
      src.indexOf("export function CrewSurface"),
    );
    expect(type).not.toContain("flags");
  });

  it("only shows the loading screen when there is nothing to show", async () => {
    const src = stripComments(await readSrc(CREW));
    expect(src).toContain(
      "setLoading(peekCache<CrewBoard>(boardKey) === undefined);",
    );
    // The unconditional `setLoading(true)` is what put "Reading…" over a board
    // that was already on screen.
    const refresh = src.slice(
      src.indexOf("const refresh = useCallback(async () => {"),
      src.indexOf("}, [repoRoot, boardKey]);"),
    );
    expect(refresh).not.toContain("setLoading(true)");
  });
});
