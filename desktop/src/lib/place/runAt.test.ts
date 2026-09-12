import { describe, expect, test } from "bun:test";

import { composeRemoteRun, shellWord } from "./runAt";

describe("composeRemoteRun", () => {
  test("the boot line comes first, the command on its own line after it", () => {
    expect(composeRemoteRun("open-the-box\n", "bun run dev")).toBe(
      "open-the-box\nbun run dev",
    );
  });

  test("a launched worktree is entered before the command runs", () => {
    expect(
      composeRemoteRun("open-the-box", "make dev", "/home/ubuntu/app-feat-x"),
    ).toBe("open-the-box\ncd '/home/ubuntu/app-feat-x' && make dev");
    // No worktree, or a blank one, means the boot line's own folder.
    expect(composeRemoteRun("open-the-box", "make dev", null)).toBe(
      "open-the-box\nmake dev",
    );
    expect(composeRemoteRun("open-the-box", "make dev", "  ")).toBe(
      "open-the-box\nmake dev",
    );
  });

  test("a folder name cannot end the quote it is wrapped in", () => {
    expect(shellWord("/home/u/it's here")).toBe(`'/home/u/it'\\''s here'`);
    expect(composeRemoteRun("b", "x", "/home/u/it's")).toBe(
      "b\ncd '/home/u/it'\\''s' && x",
    );
  });
});
