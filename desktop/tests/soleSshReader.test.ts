// Reading five languages well enough to guard them.
//
//   bun test
//
// A guard that reads its corpus wrong passes for the wrong reason, which is the
// quietest failure there is — so the reading is tested as carefully as the rule
// that uses it. Every case below is a real shape out of this repo, not an
// invented one, because the two ways this breaks are both about real habits:
// prose that looks like code, and code that looks like prose.
//
// The direction matters. A reader that mistakes CODE for a comment blanks it,
// and the spawn inside it can no longer be found — the file passes. That is the
// failure to be paranoid about, and most of what follows is aimed at it.

import { describe, expect, test } from "bun:test";

import {
  familyOf,
  isReadable,
  kinds,
  productionRust,
  readable,
  withoutComments,
} from "./support/sourceKinds";

describe("which reader a file wants", () => {
  test("Rust is its own family, because its quotes are its own", () => {
    expect(familyOf("a/b.rs")).toBe("rust");
    expect(familyOf("a/b.ts")).toBe("c");
    expect(familyOf("a/b.tsx")).toBe("c");
    expect(familyOf("deploy.sh")).toBe("hash");
    expect(familyOf("x.py")).toBe("hash");
    expect(familyOf("ci.yml")).toBe("hash");
  });

  test("a language nobody here writes is not read at all", () => {
    // Not read *wrongly*, which is the point: `readable` hands back nothing so
    // no caller can mistake an unparsed file for a clean one.
    expect(familyOf("README.md")).toBe("unknown");
    expect(isReadable("package.json")).toBe(false);
    expect(readable("README.md", 'ssh -i "$KEY" a@b')).toBe("");
  });
});

describe("prose that looks like code", () => {
  test("a comment about ssh is not a call to ssh", () => {
    // This repo's place modules are *made* of these. A guard that fired on them
    // would be switched off within a week.
    const src = [
      "// This used to build Command::new(\"ssh\") itself.",
      "/* and -o StrictHostKeyChecking=accept-new with it */",
      "fn f() { real(); }",
    ].join("\n");
    const out = withoutComments(src, "rust");
    expect(out).not.toContain("ssh");
    expect(out).toContain("fn f() { real(); }");
  });

  test("a `#` comment in a shell script goes, and the command stays", () => {
    const src = ['# ssh -i "$KEY" ubuntu@box   <- what we used to do', "aura runner serve"].join(
      "\n",
    );
    const out = withoutComments(src, "hash");
    expect(out).not.toContain("ssh");
    expect(out).toContain("aura runner serve");
  });

  test("a line comment keeps its line, so a finding names the right one", () => {
    // Blanked rather than removed. A guard that reports "line 40" about a file
    // whose lines it renumbered sends somebody to the wrong place.
    const src = "one\n// two\nthree";
    expect(withoutComments(src, "c").split("\n").length).toBe(3);
    expect(withoutComments(src, "c").split("\n")[2]).toBe("three");
  });
});

describe("code that looks like prose", () => {
  test("a `//` inside a string does not start a comment", () => {
    // The classic. Read as a comment, the rest of the line vanishes — and with
    // it whatever came after the URL.
    const src = 'const u = "https://example.com"; const p = Command("ssh");';
    const out = withoutComments(src, "c");
    expect(out).toContain('"ssh"');
    expect(out).toContain("https://example.com");
  });

  test("JSX prose containing `/*` does not blank the rest of the file", () => {
    // `SettingsDialog.tsx` renders `themes/*.json`, and reading that as an open
    // block comment once swallowed thirty-two thousand characters. For a guard
    // that direction is the dangerous one: a blanked region is a region where a
    // spawn cannot be found.
    const src = [
      "export function S() {",
      "  return <code>themes/*.json</code>;",
      "}",
      'const boot = spawn("ssh");',
    ].join("\n");
    const out = withoutComments(src, "c");
    expect(out).toContain('spawn("ssh")');
  });

  test("a Rust lifetime is not an unterminated character literal", () => {
    // `&'a str` read as a literal never closes, and every character after it in
    // the file is text — after which the guard sees no code at all and passes.
    const src = "fn f<'a>(s: &'a str) -> &'a str { s }\nfn g() { spawn(\"ssh\"); }";
    expect(kinds(src, "rust").every((k) => k === "code" || k === "text")).toBe(true);
    expect(withoutComments(src, "rust")).toContain('spawn("ssh")');
  });

  test("a Rust character that is several bytes is still one character", () => {
    // This crate's prose is full of `'…'`.
    const src = "fn f(c: char) -> bool { c == '…' || c == 'a' }\nfn kept() {}";
    const k = kinds(src, "rust");
    expect(k[src.indexOf("…")]).toBe("text");
    expect(k[src.indexOf("kept")]).toBe("code");
  });

  test("a Rust raw string is text, and the code after it is not", () => {
    const src = 'let re = r#"fn dial("#;\nfn kept() { spawn("ssh"); }';
    const k = kinds(src, "rust");
    expect(k[src.indexOf("kept")]).toBe("code");
    expect(withoutComments(src, "rust")).toContain('spawn("ssh")');
  });

  test("a shell's single quotes suspend the backslash", () => {
    // Reading `'\'` as an escaped quote runs the literal to the end of the file
    // and blanks every command after it.
    const src = "echo 'a\\'\nssh -i \"$KEY\" ubuntu@box";
    expect(withoutComments(src, "hash")).toContain("ssh -i");
  });

  test("a `#` inside a Python docstring is not a comment", () => {
    const src = ['"""usage: # not a comment"""', 'run(["ssh", "-i", key])'].join("\n");
    expect(withoutComments(src, "hash")).toContain('"ssh"');
  });

  test("a TypeScript single-quoted string is a string, not a lifetime", () => {
    // The same character, the opposite meaning, which is why Rust is its own
    // family rather than sharing the C one.
    const src = "const argv = ['ssh', '-i', key];";
    expect(withoutComments(src, "c")).toContain("'ssh'");
    expect(kinds(src, "c")[src.indexOf("ssh")]).toBe("text");
  });
});

describe("what ships, in Rust", () => {
  test("a test-gated item goes, and its neighbours stay", () => {
    const src = [
      "pub fn real() { keep(); }",
      "#[cfg(test)]",
      "mod tests {",
      '    fn live() { Command::new("ssh"); }',
      "}",
      "pub fn also_real() {}",
    ].join("\n");
    const out = productionRust(src);
    expect(out).toContain("pub fn real");
    expect(out).toContain("pub fn also_real");
    expect(out).not.toContain("ssh");
  });

  test("a file gated whole is no production code at all", () => {
    // `sole_ssh.rs` is exactly this. Without it the guard would police itself
    // and fail on its own constants.
    expect(productionRust('//! docs\n#![cfg(test)]\nfn f() { spawn("ssh"); }')).toBe("");
  });

  test("`not(test)` means production, and stays", () => {
    const src = '#[cfg(not(test))]\npub fn real() { spawn("ssh"); }';
    expect(productionRust(src)).toContain("real");
  });

  test("an and-gate still counts as a test gate", () => {
    const src = "#[cfg(all(test, debug_assertions))]\nmod t { fn f() {} }\npub fn kept() {}";
    const out = productionRust(src);
    expect(out).not.toContain("mod t");
    expect(out).toContain("pub fn kept");
  });

  test("a gated import ends at its semicolon", () => {
    const src = "#[cfg(test)]\nuse super::*;\npub fn kept() {}";
    const out = productionRust(src);
    expect(out).not.toContain("use super");
    expect(out).toContain("pub fn kept");
  });

  test("a brace inside a string does not end an item", () => {
    // tmux format strings are full of unbalanced-looking braces, and one
    // miscounted brace swallows the rest of the file — after which every
    // assertion downstream passes on nothing.
    const src = [
      "#[cfg(test)]",
      "mod t {",
      '    fn f() { let s = "#{{pane_current_command}} } {"; }',
      "}",
      'pub fn survives() { spawn("ssh"); }',
    ].join("\n");
    const out = productionRust(src);
    expect(out).toContain("pub fn survives");
    expect(out).not.toContain("pane_current_command");
  });

  test("a semicolon inside an attribute string does not end an item", () => {
    // `#[ignore = "needs a real box; set AURA_LIVE_MACHINE"]` sits between the
    // gate and the body of every live test in the place modules.
    const src = [
      "#[cfg(test)]",
      '#[ignore = "needs a real box; set AURA_LIVE_MACHINE"]',
      "fn live() { dial(m); }",
      "pub fn survives() {}",
    ].join("\n");
    const out = productionRust(src);
    expect(out).toContain("pub fn survives");
    expect(out).not.toContain("dial(m)");
  });

  test("`readable` does both jobs, in the right order", () => {
    const src = [
      "//! a module that used to spawn ssh",
      "#[cfg(test)]",
      'mod t { fn f() { Command::new("ssh"); } }',
      "pub fn ships() {}",
    ].join("\n");
    expect(readable("a/b.rs", src)).toContain("pub fn ships");
    expect(readable("a/b.rs", src)).not.toContain("ssh");
  });
});
