import { describe, expect, test } from "bun:test";

import { normalizePath } from "./paths";

describe("normalizePath", () => {
  test("a CLI's repo-relative path outside the repo resolves to the real file", () => {
    // Claude printed "Write(../../../.claude/jobs/3518ab13/tmp/closure.ts)"
    // from inside the repo; the terminal link joined it to the cwd.
    expect(
      normalizePath("/Users/mo/Documents/acme/app/../../../.claude/jobs/3518ab13/tmp/closure.ts"),
    ).toBe("/Users/mo/.claude/jobs/3518ab13/tmp/closure.ts");
  });

  test("a clean path comes back as the same string", () => {
    const p = "/Users/mo/code/aura/src/main.ts";
    expect(normalizePath(p)).toBe(p);
    expect(normalizePath("/repo/dir/")).toBe("/repo/dir/");
  });

  test("dot segments and doubled slashes fold away", () => {
    expect(normalizePath("/repo/./src//lib/a.ts")).toBe("/repo/src/lib/a.ts");
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("/repo/src/..")).toBe("/repo");
  });

  test("an absolute path cannot climb above the root", () => {
    expect(normalizePath("/../../etc/hosts")).toBe("/etc/hosts");
    expect(normalizePath("/a/..")).toBe("/");
  });

  test("a relative path keeps the climb it cannot resolve", () => {
    expect(normalizePath("../../x.ts")).toBe("../../x.ts");
    expect(normalizePath("a/../../x.ts")).toBe("../x.ts");
    expect(normalizePath("a/..")).toBe(".");
  });

  test("dotfiles and dotted names are not dot segments", () => {
    expect(normalizePath("/repo/.env")).toBe("/repo/.env");
    expect(normalizePath("/repo/..hidden/a.ts")).toBe("/repo/..hidden/a.ts");
    expect(normalizePath("/repo/.../a.ts")).toBe("/repo/.../a.ts");
  });

  test("URIs, backslash paths and empty input are left alone", () => {
    expect(normalizePath("file:///repo/../a.ts")).toBe("file:///repo/../a.ts");
    expect(normalizePath("C:\\repo\\..\\a.ts")).toBe("C:\\repo\\..\\a.ts");
    expect(normalizePath("")).toBe("");
  });
});
