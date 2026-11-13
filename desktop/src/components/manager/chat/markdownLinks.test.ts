import { describe, expect, test } from "bun:test";
import { isUrlLike } from "./Markdown";

describe("inline code read as a web address", () => {
  test("a bare name on a web domain ending is an address", () => {
    for (const t of ["example.com", "docs.example.dev/guide", "www.example.org", "github.io", "auravcs.com/download"]) {
      expect(isUrlLike(t)).toBe(true);
    }
  });

  test("an address with a scheme is an address", () => {
    expect(isUrlLike("https://Promise.all")).toBe(true);
    expect(isUrlLike("mailto:team@example.com")).toBe(true);
  });

  test("a property on a code value is not an address", () => {
    for (const t of ["Promise.all", "console.log", "api.tasksCreate", "Object.is", "Array.at", "foo.length", "self.state"]) {
      expect(isUrlLike(t)).toBe(false);
    }
  });

  test("a file name is a file, not an address", () => {
    for (const t of ["deploy.sh", "main.rs", "README.md", "package.json"]) {
      expect(isUrlLike(t)).toBe(false);
    }
  });

  test("prose and commands are not addresses", () => {
    expect(isUrlLike("cargo build")).toBe(false);
    expect(isUrlLike("localhost")).toBe(false);
  });
});
