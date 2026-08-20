// Seeding a surface from the last read is only safe if what got cached was a
// real answer. These pin the two places where caching the wrong thing would
// quietly reintroduce a bug the code already carries a comment about.

import { describe, expect, it } from "bun:test";

import { readSrc, stripComments } from "./support/code";

const WORKSPACES = "components/workpanes/workspaces/WorkspacesPane.tsx";
const CREW = "components/commons/crew/CrewSurface.tsx";

/** The body of `load`, comments removed. */
async function loadBody(): Promise<string> {
  const src = stripComments(await readSrc(WORKSPACES));
  const start = src.indexOf("const load = useCallback(async () => {");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("}, [repoRoot]);", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("Workspaces only remembers a plane that has real numbers in it", () => {
  it("caches the full plane", async () => {
    const body = await loadBody();
    expect(body).toContain("writeCache(`workspaces:${target}`, full)");
  });

  it("never caches the fast pass", async () => {
    // `worktreePlane(target, false)` skips git, so every checkout comes back
    // dirty_files = 0 and ahead = 0. Those are the exact two fields isQuiet()
    // reads, so a cached quick plane would seed the next visit with rows that
    // look quiet, and quiet rows are hidden — checkouts would vanish and
    // reappear. Whatever the fast pass is for, it is not an answer to keep.
    const body = await loadBody();
    const quickIdx = body.indexOf("const quick = await api.worktreePlane(target, false)");
    expect(quickIdx).toBeGreaterThan(-1);
    const fullIdx = body.indexOf("const full = await api.worktreePlane(target, true)");
    expect(fullIdx).toBeGreaterThan(quickIdx);
    // No cache write anywhere in the fast-pass branch.
    expect(body.slice(quickIdx, fullIdx)).not.toContain("writeCache");
    expect(body).not.toContain("writeCache(`workspaces:${target}`, quick)");
  });

  it("skips the fast pass when a full plane is already seeded", async () => {
    // The fast pass exists to avoid a blank first paint. With a cached plane
    // there is no blank first paint, so running it would replace good numbers
    // with zeros for a moment — worse than not running it at all.
    const src = stripComments(await readSrc(WORKSPACES));
    expect(src).toContain(
      "const painted = useRef(peekCache<WorktreePlane>(planeKey) !== undefined);",
    );
  });

  it("does not blank the plane on the way in", async () => {
    const src = stripComments(await readSrc(WORKSPACES));
    // The old mount effect did `setPlane(null)`, which is what made every
    // visit start empty.
    const start = src.indexOf("const known = peekCache<WorktreePlane>(planeKey);");
    expect(start).toBeGreaterThan(-1);
    const effect = src.slice(start, src.indexOf("}, [load, planeKey]);", start));
    expect(effect).toContain("setPlane(known ?? null)");
    expect(effect).not.toContain("setPlane(null)");
  });
});

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
