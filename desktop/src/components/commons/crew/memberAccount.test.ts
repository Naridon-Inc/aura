import { describe, expect, test } from "bun:test";

import { becomeMember, sawWho, WHOAMI, whoProbe, writeRunnerEnv } from "./memberAccount";

// Who a session IS decides where the next hour of work lands: a token written
// one shell too early belongs to the login everybody shares. These pin the
// three strings that decide it.

describe("asking a shell who it is", () => {
  test("the question cannot be mistaken for the answer", () => {
    // The terminal echoes what we type. A probe that matched its own echo would
    // report the shell we were about to leave — which, right after a handover,
    // is precisely the wrong one.
    expect(sawWho(whoProbe())).toBeNull();
  });

  test("the answer names the login", () => {
    const stream = `${whoProbe()}\r\n${WHOAMI} ubuntu\r\nubuntu@box:~$ `;
    expect(sawWho(stream)).toBe("ubuntu");
  });

  test("a shell that hasn't answered yet says nothing", () => {
    expect(sawWho("Welcome to Ubuntu 24.04.4 LTS\r\nubuntu@box:~$ ")).toBeNull();
  });

  test("after a handover the second answer is the true one", () => {
    // One stream, two shells: the shared login we arrived as, then the member
    // we became. Reading the first would have us write the member's token into
    // the shared account's home.
    const stream = [
      `${WHOAMI} ubuntu`,
      becomeMember("mo"),
      `${WHOAMI} mo`,
      "mo@box:~$ ",
    ].join("\r\n");
    expect(sawWho(stream)).toBe("mo");
  });

  test("a coloured prompt around the answer doesn't hide it", () => {
    const stream = `\x1b[32m${WHOAMI} mo\x1b[0m\r\n`;
    expect(sawWho(stream)).toBe("mo");
  });

  test("a refused handover is visible as the login we never left", () => {
    // `sudo -n` fails outright rather than prompting, so the outer shell answers
    // — and answering as the shared login is how the wizard learns the member
    // never got their own.
    const stream = [
      becomeMember("mo"),
      "sudo: a password is required",
      `${WHOAMI} ubuntu`,
    ].join("\r\n");
    expect(sawWho(stream)).toBe("ubuntu");
  });
});

describe("becoming the member", () => {
  test("it is a login shell for that account, and it never prompts", () => {
    expect(becomeMember("mo")).toBe("sudo -n -u 'mo' -i");
  });

  test("a login goes to the shell as one argument", () => {
    expect(becomeMember("mo'; rm -rf /")).toBe(`sudo -n -u 'mo'\\''; rm -rf /' -i`);
  });

  test("the session survives a refusal", () => {
    // Not `exec`: a sudo that exits non-zero would take the whole SSH session
    // with it, and the wizard could no longer say what went wrong.
    expect(becomeMember("mo").startsWith("exec ")).toBe(false);
  });
});

describe("writing the member's runner token", () => {
  test("nobody but the member can read it", () => {
    const cmd = writeRunnerEnv();
    // The default umask on a stock box is 022, so a plain redirection lands
    // 0644 — every other member of a shared machine could check work in as
    // this one.
    expect(cmd).toContain("umask 077");
    expect(cmd).toContain("chmod 600 ~/.config/aura/runner.env");
    expect(cmd).toContain("chmod 700 ~/.config/aura");
  });

  test("the token is read from the shell, not typed again", () => {
    // It has already been exported. Interpolating it a second time would put
    // the secret in the box's shell history twice.
    expect(writeRunnerEnv()).toContain('"$AURA_RUNNER_TOKEN"');
  });

  test("it writes where the runner looks", () => {
    // `aura runner install` points the unit's EnvironmentFile at the first
    // runner.env it finds, and this is the first place it looks.
    expect(writeRunnerEnv()).toContain("~/.config/aura/runner.env");
  });
});
