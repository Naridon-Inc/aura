import { describe, expect, test } from "bun:test";

import type { PaletteEntry } from "../CommandPalette";
import { allLaneHits, intentEntries, laneHits, scoreEntries } from "./paletteHits";

const file = (path: string): PaletteEntry => ({ kind: "file", id: `/r/${path}`, label: path.split("/").pop() ?? path, hint: path });
const slash = (name: string): PaletteEntry => ({ kind: "slash", id: name, label: name, hint: "" });

describe("palette lane ranking", () => {
  test("a name match outranks a path match, and a shallower file wins a tie", () => {
    const pool = [file("deep/a/b/index.ts"), file("src/index.ts"), file("index/readme.md")];
    expect(scoreEntries(pool, "index").map((e) => e.id)).toEqual([
      "/r/src/index.ts",
      "/r/deep/a/b/index.ts",
      "/r/index/readme.md",
    ]);
  });

  test("a prefix keeps its own lane only", () => {
    const pool = [file("src/plan.ts"), slash("plan")];
    expect(laneHits({ lane: "slash", q: "plan", pool, symbolHits: [], grepHits: [] }).map((e) => e.kind)).toEqual([
      "slash",
    ]);
    expect(laneHits({ lane: "file", q: "", pool, symbolHits: [], grepHits: [] }).map((e) => e.kind)).toEqual(["file"]);
  });

  test("reasons match on their text, at most six", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      id: `intent:${i}`,
      intent: `fix the retry ${i}`,
      timestamp: i,
      agent: "cli:claude",
      fileCount: 0,
    }));
    expect(intentEntries(rows, "retry")).toHaveLength(6);
    expect(intentEntries(rows, "nothing")).toHaveLength(0);
  });

  test("a reason's age reads the log's seconds, not 56 years", () => {
    const at = Math.floor(Date.now() / 1000) - 120;
    const [hit] = intentEntries(
      [{ id: `intent:${at}`, intent: "fix the retry", timestamp: at, agent: "cli:claude", fileCount: 1 }],
      "retry",
    );
    expect(hit.kind === "intent" && hit.hint).toContain("2m ago");
    expect(hit.kind === "intent" && hit.hint).not.toContain("y ago");
    // The jump still matches the log's own stamp.
    expect(hit.kind === "intent" && hit.timestamp).toBe(at);
  });

  test("nothing typed, no lane rows", () => {
    const hits = allLaneHits({ q: "", files: [file("a.ts")], commands: [], symbolHits: [], grepHits: [], intentRows: [], chatHits: [] });
    expect(hits.files).toHaveLength(0);
  });
});
