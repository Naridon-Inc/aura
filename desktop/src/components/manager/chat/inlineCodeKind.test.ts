// Run with: bun test src/components/manager/chat/inlineCodeKind.test.ts
//
// Which icon an inline code chip in an answer gets: a branch draws the branch
// mark, a path keeps the folder or file one.

import { describe, expect, test } from "bun:test";
import { inlineCodeKind } from "./Markdown";

describe("an inline code chip's kind", () => {
  test("a branch is a branch, not a folder", () => {
    expect(inlineCodeKind("feat/cloud-parity")).toBe("branch");
    expect(inlineCodeKind("release/0.20.1-integration")).toBe("branch");
    expect(inlineCodeKind("origin/main")).toBe("branch");
  });

  test("paths keep their folder and file kinds", () => {
    expect(inlineCodeKind("src/components")).toBe("folder");
    expect(inlineCodeKind("src/components/")).toBe("folder");
    expect(inlineCodeKind("docs/guide")).toBe("folder");
    expect(inlineCodeKind("fix/notes.md")).toBe("file");
    expect(inlineCodeKind("aura-shell/src/lib/api.ts:42")).toBe("file");
  });

  test("a bare word is neither", () => {
    expect(inlineCodeKind("main")).toBeNull();
  });
});
