// The helper every source scan trusts.
//
//   bun test
//
// `stripComments` decides what the rest of tests/ is allowed to see. When it
// deletes too much, an assertion about code that is plainly there fails as
// "not found" — annoying, but loud. The dangerous half is the other one: a
// `.not.toContain` passes over a file with its middle removed, and reports a
// defect as fixed.
//
// It happened. `<code>themes/*.json</code>` in SettingsDialog.tsx opened a
// match that ran to the next real `*/`, taking 32,791 characters — a quarter
// of the file — out of every scan. These cases pin the distinction that
// stopped it: a comment opener follows whitespace or a delimiter, prose
// doesn't.

import { describe, expect, test } from "bun:test";

import { stripComments } from "./support/code";

describe("stripComments", () => {
  test("a glob in JSX text is not a comment opener", () => {
    const src = [
      "const a = 1;",
      "<code>themes/*.json</code>",
      "const keep = 2;",
      "/* a real comment */",
      "const alsoKeep = 3;",
    ].join("\n");
    const out = stripComments(src);
    expect(out).toContain("const keep = 2;");
    expect(out).toContain("const alsoKeep = 3;");
    expect(out).toContain("themes/*.json");
    expect(out).not.toContain("a real comment");
  });

  test("real block comments still go, wherever they start", () => {
    const src = [
      "/* leading */",
      "const a = 1; /* trailing */",
      "call(/* inline */ x);",
      "const b = 2;",
    ].join("\n");
    const out = stripComments(src);
    expect(out).not.toContain("leading");
    expect(out).not.toContain("trailing");
    expect(out).not.toContain("inline");
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;");
  });

  test("line comments go first, so a glob inside one can't open a block", () => {
    // This is the older failure the header describes: a line comment naming a
    // wildcard path, followed much later by a real `*/`.
    const src = [
      "// ignores .aura/**/*.json for now",
      "const keep = 1;",
      "/* real */",
      "const stillHere = 2;",
    ].join("\n");
    const out = stripComments(src);
    expect(out).toContain("const keep = 1;");
    expect(out).toContain("const stillHere = 2;");
    expect(out).not.toContain("real");
    expect(out).not.toContain("ignores .aura");
  });

  test("a JSX comment goes as one piece, braces and all", () => {
    const out = stripComments("{/* explain the row */}\nconst a = 1;");
    expect(out).not.toContain("explain the row");
    expect(out).toContain("const a = 1;");
  });

  test("an unterminated comment runs to the end, and nothing throws", () => {
    const out = stripComments("const a = 1;\n/* never closed\nconst b = 2;");
    expect(out).toContain("const a = 1;");
    expect(out).not.toContain("const b = 2;");
  });
});
