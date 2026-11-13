import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { myGithubConnectLabel } from "./useMyGithubConnect";

describe("connecting your own GitHub where it is asked for", () => {
  test("the button says where connecting is", () => {
    expect(myGithubConnectLabel(false, false)).toBe("Connect your GitHub");
    expect(myGithubConnectLabel(true, false)).toBe("Opening GitHub…");
    expect(myGithubConnectLabel(false, true)).toBe("Open GitHub again");
  });

  test("the create dialog connects in place instead of sending you to Settings", () => {
    const src = readFileSync(join(import.meta.dir, "CloudCreateDialog.tsx"), "utf8");
    expect(src).toContain("useMyGithubConnect(");
    expect(src).not.toContain("openYourGithub");
  });
});
