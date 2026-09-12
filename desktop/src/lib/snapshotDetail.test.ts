import { describe, expect, test } from "bun:test";
import {
  describeSnapshot,
  savePointLabel,
  savePointName,
  sizeOf,
  takenAt,
  whenItWasTaken,
} from "./snapshotDetail";
import type { SnapshotDetail } from "./api";

const snap = (over: Partial<SnapshotDetail> = {}): SnapshotDetail => ({
  file_path: "src/billing.py",
  content: "def total():\n    return 0\n",
  timestamp: 1789112002925,
  trigger: "pre_tool_use",
  agent_id: "claude",
  why: null,
  ...over,
});

describe("opening a save point", () => {
  test("says when it was taken before showing the file", () => {
    const body = describeSnapshot(snap());
    const firstLine = body.split("\n")[0];
    expect(firstLine).not.toContain("def total");
    expect(body).toContain("right before something edited this file");
    expect(body).toContain("def total():");
  });

  test("the author's reason is shown when one was recorded", () => {
    const body = describeSnapshot(
      snap({ why: "round to cents so invoices match the bank" }),
    );
    expect(body).toContain("Reason given: round to cents so invoices match the bank");
  });

  test("no reason recorded means no empty label", () => {
    const body = describeSnapshot(snap({ why: null }));
    expect(body).not.toContain("Reason given");
  });

  test("an unknown author is not announced as unknown", () => {
    const body = describeSnapshot(snap({ agent_id: "unknown" }));
    expect(body).not.toContain("unknown");
  });

  test("an empty save point says so rather than looking like a failure", () => {
    const body = describeSnapshot(snap({ content: "" }));
    expect(body).toContain("The file was empty at this point.");
  });
});

describe("saying why a save point exists", () => {
  test("every trigger the codebase writes reads as a sentence", () => {
    const written = [
      "pre_tool_use",
      "pre_edit",
      "mcp_pre_edit",
      "pre_rewind",
      "pre_deletion_guard",
      "pre_dispatch_guard",
      "pre_commit",
      "manual",
      "auto_pulled_from_cloud",
    ];
    for (const t of written) {
      const said = whenItWasTaken(t);
      expect(said).not.toContain("_");
      expect(said.endsWith(".")).toBe(true);
    }
  });

  test("a trigger nobody has seen is shown, not swallowed", () => {
    expect(whenItWasTaken("some_new_thing")).toContain("some_new_thing");
  });
});

describe("the timestamp", () => {
  test("a missing stamp is left out rather than printed as 1970", () => {
    expect(takenAt(0)).toBeNull();
    expect(takenAt(Number.NaN)).toBeNull();
  });

  test("a real stamp becomes a local date", () => {
    expect(takenAt(1789112002925)).not.toBeNull();
  });
});

describe("the size line", () => {
  test("one line is not called 1 lines", () => {
    expect(sizeOf("just this")).toBe("1 line saved.");
  });

  test("many lines are counted", () => {
    expect(sizeOf("a\nb\nc")).toBe("3 lines saved.");
  });
});

describe("reading a save point's own file name", () => {
  test("the mangled storage name gives back the file that was saved", () => {
    const { path } = savePointName("aura-shell__src__lib__api.ts__1788970329784.json");
    expect(path).toBe("aura-shell/src/lib/api.ts");
  });

  test("an absolute path keeps its leading slash", () => {
    const { path } = savePointName("__Users__dev__proj__src__billing.py__1788970329784.json");
    expect(path).toBe("/Users/dev/proj/src/billing.py");
  });

  test("single underscores inside a file name survive", () => {
    const { path } = savePointName("aura-shell__src-tauri__src__cmd_aura_fs.rs__1789112544617.json");
    expect(path).toBe("aura-shell/src-tauri/src/cmd_aura_fs.rs");
  });

  test("the stamp on the end is the time, not part of the path", () => {
    const { takenAtMs } = savePointName("src__a.ts__1788970329784.json");
    expect(takenAtMs).toBe(1788970329784);
  });

  test("a name with no stamp is still readable, with no invented time", () => {
    const { path, takenAtMs } = savePointName("src__a.ts.json");
    expect(path).toBe("src/a.ts");
    expect(takenAtMs).toBeNull();
  });

  test("a file whose name ends in digits is not mistaken for a stamp", () => {
    const { path, takenAtMs } = savePointName("src__migration_070.sql__1788970329784.json");
    expect(path).toBe("src/migration_070.sql");
    expect(takenAtMs).toBe(1788970329784);
  });

  test("the row says the file and when it was kept, not the storage name", () => {
    const [first, second] = savePointLabel("aura-shell__src__lib__api.ts__1788970329784.json");
    expect(first).toBe("aura-shell/src/lib/api.ts");
    expect(first).not.toContain("__");
    expect(second).toStartWith("saved ");
    expect(second).not.toBe(first);
  });
});
