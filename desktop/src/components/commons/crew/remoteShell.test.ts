import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import {
  readyProbe,
  sawReady,
  SHELL_READY,
  shQuote,
} from "./remoteShell";

// The whole probe rests on one property: the command we type must not look
// like the answer we're waiting for. A terminal echoes what you type, so a
// naive `echo MARKER` matches on the echo and declares a shell ready while
// ssh is still handshaking — which is the exact bug this module exists to
// stop. These pin that property down.

describe("knocking on a remote shell", () => {
  test("the command we type cannot be mistaken for the answer", () => {
    expect(sawReady(readyProbe())).toBe(false);
  });

  test("the command's output is the answer", () => {
    // What the terminal carries: our line echoed back, then the shell running
    // it, then a prompt.
    const stream = `${readyProbe()}\r\n${SHELL_READY}\r\nubuntu@box:~$ `;
    expect(sawReady(stream)).toBe(true);
  });

  test("a shell that never answers is not ready", () => {
    const stream = [
      "ssh -i \"$HOME/key.pem\" ubuntu@203.0.113.10",
      "Welcome to Ubuntu 24.04.4 LTS (GNU/Linux 7.0.0-1009-aws aarch64)",
      "ubuntu@box:~$ ",
    ].join("\r\n");
    expect(sawReady(stream)).toBe(false);
  });

  test("an answer is found however much noise arrives around it", () => {
    // The MOTD, a slow login banner and our own repeated knocks all share the
    // stream; the answer still counts wherever it lands.
    const stream = `banner\r\n${readyProbe()}\r\n\x1b[0m${SHELL_READY}\x1b[0m\r\n`;
    expect(sawReady(stream)).toBe(true);
  });
});

// The machine name is typed by a person and then sent to a real bash. These pin
// that no name can turn one command into two.

describe("quoting what we type at the far shell", () => {
  test("an ordinary name is passed through as one argument", () => {
    expect(shQuote("build-box")).toBe("'build-box'");
  });

  test("a name with spaces stays a single argument", () => {
    expect(shQuote("Mo's spare mac")).toBe(`'Mo'\\''s spare mac'`);
  });

  test("nothing inside single quotes can start a command", () => {
    // The characters bash would otherwise act on — none of them survive as
    // syntax, so the worst a hostile name can do is name itself badly.
    for (const evil of [
      "; rm -rf /",
      "$(whoami)",
      "`id`",
      "a && b",
      "x | y",
      "$HOME",
    ]) {
      expect(shQuote(evil)).toBe(`'${evil}'`);
    }
  });

  test("a quote can't close the string and escape", () => {
    // The classic break-out: end the quote, run a command, reopen. After
    // quoting there is no point at which the shell is outside a quoted run.
    const q = shQuote("box'; rm -rf ~; echo '");
    expect(q.startsWith("'")).toBe(true);
    expect(q.endsWith("'")).toBe(true);
    expect(q).toBe(`'box'\\''; rm -rf ~; echo '\\'''`);
  });

  test("it still agrees, row for row, with the Rust it was copied from", () => {
    // The rest of this describe says what the rule IS. This says the other
    // half of the app still spells it the same way — `cloudbox::script::quote`
    // reads the same file and asserts the same rows, so neither can change
    // without the other going red. Without it the two agree for exactly as
    // long as nobody edits either.
    const table = JSON.parse(
      readFileSync(
        new URL(
          "../../../../src-tauri/src/cloudbox/quoting.cases.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { cases: { raw: string; quoted: string }[] };

    expect(table.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of table.cases) {
      expect(shQuote(c.raw)).toBe(c.quoted);
    }
  });
});
