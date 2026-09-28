import { describe, expect, test } from "bun:test";

import { emptySnapshot, withNormalizedFilePaths } from "./workspaceSnapshot";

const DOTTED = "/Users/mo/acme/app/../../.claude/jobs/1/tmp/closure.ts";
const CLEAN = "/Users/mo/.claude/jobs/1/tmp/closure.ts";

describe("withNormalizedFilePaths", () => {
  test("a tab saved under a ../ spelling restores under the clean one, everywhere it is named", () => {
    const snap = {
      ...emptySnapshot(),
      filePaths: [DOTTED, "/Users/mo/acme/app/src/a.ts"],
      activePath: DOTTED,
      splitLayout: {
        kind: "split" as const,
        direction: "row" as const,
        children: [
          { kind: "leaf" as const, paneId: "p1", activeIndex: 0, tabs: [{ kind: "file" as const, path: DOTTED }] },
          { kind: "leaf" as const, paneId: "p2", activeIndex: 0, tabs: [{ kind: "agent" as const, id: "a1" }] },
        ],
      },
    };
    const out = withNormalizedFilePaths(snap);
    expect(out.filePaths).toEqual([CLEAN, "/Users/mo/acme/app/src/a.ts"]);
    expect(out.activePath).toBe(CLEAN);
    expect(out.splitLayout).toEqual({
      ...snap.splitLayout,
      children: [
        { kind: "leaf", paneId: "p1", activeIndex: 0, tabs: [{ kind: "file", path: CLEAN }] },
        { kind: "leaf", paneId: "p2", activeIndex: 0, tabs: [{ kind: "agent", id: "a1" }] },
      ],
    });
  });

  test("two spellings of one file restore as one tab", () => {
    const out = withNormalizedFilePaths({ ...emptySnapshot(), filePaths: [DOTTED, CLEAN] });
    expect(out.filePaths).toEqual([CLEAN]);
  });

  test("a clean snapshot restores unchanged", () => {
    const snap = { ...emptySnapshot(), filePaths: ["/repo/a.ts"], activePath: "/repo/a.ts" };
    expect(withNormalizedFilePaths(snap)).toEqual(snap);
  });
});
