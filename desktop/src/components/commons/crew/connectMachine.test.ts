// Connecting a machine, decided rather than drawn.
//
// This wizard is the one flow in the app that types real commands into
// somebody else's computer, so the cost of each of these being wrong is not a
// wrong pixel. A shared box gets one runner for everybody. A sign-in link never
// recognised leaves a step waiting on a login that already happened. A board
// match one degree too loose reports success for a machine that never started,
// and the user closes the wizard believing they have a runner.

import { describe, expect, test } from "bun:test";

import type { CloudRunner } from "../../../lib/api";
import {
  EMPTY_LOG_NOTE,
  LIMIT_FLAGS,
  LOG_END,
  LOG_START,
  afterSaving,
  boardName,
  installCommand,
  keepTail,
  loginUrlIn,
  seenOnBoard,
  setupLogIn,
  tailLogCommand,
} from "./connectMachine";

describe("what the box will be called on the board", () => {
  test("what you typed, without the spaces around it", () => {
    expect(boardName("  home-server  ", "10.0.0.1")).toBe("home-server");
  });

  test("nothing typed falls back to the host, which you will recognise", () => {
    // Naming isn't blocked on the address, so this field is often still empty
    // when the rest is filled in.
    expect(boardName("", "box.example.com")).toBe("box.example.com");
    expect(boardName("   ", "  box.example.com  ")).toBe("box.example.com");
  });

  test("nothing at all is still something to click on, never an empty name", () => {
    // A runner registered under "" is one nobody can find again.
    expect(boardName("", "")).toBe("my-machine");
  });
});

describe("turning the box into a runner that outlives your laptop", () => {
  test("on your own box, the system unit first and the user unit as fallback", () => {
    const cmd = installCommand("home-server", "mine");
    expect(cmd).toContain("sudo -n aura runner install --name 'home-server'");
    // `-n`, so a box that wants a sudo password fails immediately rather than
    // hanging the wizard on a prompt nobody can see.
    expect(cmd).toContain("sudo -n ");
    expect(cmd).toContain("|| aura runner install --user --name 'home-server'");
  });

  test("on a shared box it never reaches for sudo at all", () => {
    // The parity claim of this whole step. A system unit on a shared box is one
    // runner for everybody: one set of credentials, one identity checking every
    // member's work in. It is also the version that needs root, so a member who
    // doesn't administer the machine could not set themselves up.
    const cmd = installCommand("home-server", "shared");
    expect(cmd).not.toContain("sudo");
    expect(cmd).toContain("aura runner install --user --name 'home-server'");
  });

  test("both modes install a service, not a backgrounded command", () => {
    // `nohup … &` would satisfy every other assertion here and break the one
    // promise the step makes: it dies at the box's next reboot, taking the
    // token it inherited from this shell with it.
    for (const kind of ["mine", "shared"] as const) {
      const cmd = installCommand("box", kind);
      expect(cmd).toContain("aura runner install");
      expect(cmd).not.toContain("nohup");
      expect(cmd).not.toMatch(/&\s*$/);
    }
  });

  test("both modes leave a log behind, because a failed start has to be readable", () => {
    // Without this the timeout panel has nothing to show, and "it didn't come
    // online" is the whole of what the user learns.
    expect(installCommand("box", "mine")).toContain("~/aura-runner.log");
    expect(installCommand("box", "shared")).toContain("~/aura-runner.log");
    // The fallback appends rather than truncating: the sudo attempt's failure
    // is usually the reason, and overwriting it loses exactly that.
    expect(installCommand("box", "mine")).toContain(">> ~/aura-runner.log");
  });

  test("every runner it installs is given real limits, on both kinds of box", () => {
    // The bug this exists to close. `aura runner install` has been able to
    // render `CPUQuota=` and `MemoryMax=` since the unit was first written —
    // both defaulted to unset and the wizard passed neither, so `--user`, whose
    // whole promise is that one member cannot starve another, wrote a unit with
    // no limits in it. A box set up through this wizard had *zero* per-member
    // isolation of CPU or memory.
    for (const kind of ["mine", "shared"] as const) {
      const cmd = installCommand("box", kind);
      // Every `aura runner install` in the line, not just the first: the `mine`
      // path falls back to a per-user install, and a fallback without limits is
      // the same unlimited unit arriving by a different route.
      const installs = cmd.split("||");
      expect(installs.length).toBeGreaterThan(0);
      for (const piece of installs) {
        expect(piece).toContain("--cpu-quota auto");
        expect(piece).toContain("--memory-max auto");
        expect(piece).toContain("--memory-swap-max auto");
      }
    }
  });

  test("the limits are `auto`, because this Mac has never measured that box", () => {
    // A number chosen here is most of a small box's memory and a rounding error
    // on a large one. `auto` makes the machine answer out of its own MemTotal,
    // core count and account list — which is also what keeps a place Aura
    // provisions and a box you brought on the same arithmetic, since both end
    // at this same command on the far side.
    expect(LIMIT_FLAGS).not.toMatch(/\d/);
    expect(installCommand("box", "shared")).toContain(LIMIT_FLAGS);
  });

  test("swap is limited too, because a ceiling with nothing under it is fatal", () => {
    // The 2026-08-04 wedge was a swapless box: the build hit the wall and the
    // kernel had nowhere to reclaim to. `MemoryMax` alone converts that stall
    // into an OOM kill; swap under it converts it into a slow build.
    expect(installCommand("box", "mine")).toContain("--memory-swap-max auto");
  });

  test("a name is quoted, because it is going into somebody's shell", () => {
    // Typed by a person, into a field, and then written to a remote shell. Both
    // occurrences on the `mine` path have to be quoted — one bare copy is the
    // whole vulnerability.
    const cmd = installCommand("my box; rm -rf ~", "mine");
    expect(cmd).not.toMatch(/name my box/);
    expect(cmd.match(/rm -rf/g) ?? []).toHaveLength(2);
    for (const piece of cmd.split("||")) {
      expect(piece).toMatch(/--name '[^']*my box; rm -rf ~/);
    }
  });
});

describe("reading the runner log back off the box", () => {
  test("the command's own echo does not look like the log's start", () => {
    // The fences are written split so the shell echoing the command back
    // doesn't contain them. Otherwise the scrape matches the command line
    // itself and hands the user their own `tail` invocation.
    const cmd = tailLogCommand();
    expect(cmd).not.toContain(LOG_START);
    expect(cmd).not.toContain(LOG_END);
    // But what the shell actually prints does — that is the whole mechanism.
    expect(cmd).toContain('"___AURA""_LOG_START___"');
    expect(cmd).toContain("tail -n 60 ~/aura-runner.log 2>&1");
  });

  test("nothing is reported until the closing fence arrives", () => {
    // Reporting early truncates the log at whatever byte the terminal happened
    // to flush, which is how a one-line "permission denied" gets cut in half.
    expect(setupLogIn("")).toBe(null);
    expect(setupLogIn(`${LOG_START}\nInstalling…`)).toBe(null);
  });

  test("the body between the fences, and nothing around it", () => {
    const stream = `$ echo …\n${LOG_START}\nerror: address already in use\n${LOG_END}\n$ `;
    expect(setupLogIn(stream)).toBe("error: address already in use");
  });

  test("a log too long to have kept its opening fence is still the log", () => {
    // The scrollback is trimmed to a tail, so on a long log the start falls off
    // the front. Refusing to report then would turn the most informative case —
    // lots of output — into the one that shows nothing.
    expect(setupLogIn("…rest of a long log\nfailed to bind\n" + LOG_END)).toBe(
      "…rest of a long log\nfailed to bind",
    );
  });

  test("an empty log says what to do about it, rather than nothing", () => {
    // A blank panel reads as "still loading", forever.
    expect(setupLogIn(`${LOG_START}\n   \n${LOG_END}`)).toBe(EMPTY_LOG_NOTE);
    expect(EMPTY_LOG_NOTE).toContain("on PATH");
  });

  test("terminal colour is not part of the message", () => {
    const stream = `${LOG_START}\n[31merror: no token[0m\n${LOG_END}`;
    expect(setupLogIn(stream)).toBe("error: no token");
  });
});

describe("catching the sign-in link the box prints", () => {
  test("the URL `claude setup-token` prints is recognised", () => {
    const url = loginUrlIn(
      "Browse to: https://claude.ai/oauth/authorize?code=abc123 and paste the code",
    );
    expect(url).toBe("https://claude.ai/oauth/authorize?code=abc123");
  });

  test("it is not pinned to one host, because the host has moved before", () => {
    // A pattern that only knew `claude.ai` would leave the user staring at a
    // step that had already succeeded on the box in front of them.
    expect(loginUrlIn("open https://console.anthropic.com/oauth/x")).toBe(
      "https://console.anthropic.com/oauth/x",
    );
    expect(loginUrlIn("go to https://login.example.com/device")).toBe(
      "https://login.example.com/device",
    );
  });

  test("a wrapped terminal line is not swallowed whole", () => {
    // Stopping at whitespace and quotes is what keeps the trailing prose out of
    // the URL we then open in the user's browser.
    expect(loginUrlIn('visit "https://claude.ai/login" then return here')).toBe(
      "https://claude.ai/login",
    );
  });

  test("ordinary output is not mistaken for a sign-in link", () => {
    expect(loginUrlIn("Installing aura from https://example.com/dist.tgz")).toBe(null);
    expect(loginUrlIn("")).toBe(null);
  });
});

describe("keeping the match cheap on a long-lived shell", () => {
  test("it is the newest bytes that are kept", () => {
    // The tail, not the head: what we are waiting for hasn't arrived yet.
    expect(keepTail("abcdef", 3)).toBe("def");
  });

  test("a stream shorter than the limit is untouched", () => {
    expect(keepTail("abc", 8000)).toBe("abc");
  });
});

describe("deciding the box is up", () => {
  const board = (rows: Array<[string, boolean]>): CloudRunner[] =>
    rows.map(([name, online]) => ({ name, online }) as CloudRunner);

  test("this box, online", () => {
    expect(seenOnBoard(board([["ci-box", true], ["home-server", true]]), "home-server")).toBe(
      true,
    );
  });

  test("some other box being up says nothing about this one", () => {
    // The failure that matters: the wizard declares success, the user closes
    // it, and the machine they just set up never started.
    expect(seenOnBoard(board([["ci-box", true]]), "home-server")).toBe(false);
  });

  test("registered but not up is not up", () => {
    expect(seenOnBoard(board([["home-server", false]]), "home-server")).toBe(false);
  });

  test("the match is exact, unlike anywhere else", () => {
    // Deliberately stricter than the workspace's board lookup: this wizard
    // registered the runner under this exact string moments ago, so there is
    // nothing to be lenient about and everything to lose by guessing.
    expect(seenOnBoard(board([["Home-Server", true]]), "home-server")).toBe(false);
    expect(seenOnBoard([], "home-server")).toBe(false);
  });
});

describe("the login everybody shares, once you have your own", () => {
  test("the first save is simply held, with nothing to forget", () => {
    expect(afterSaving(null, null, "ubuntu@10.0.0.1:/srv")).toEqual({
      hold: "ubuntu@10.0.0.1:/srv",
      forget: null,
    });
  });

  test("becoming a member drops the shared way in", () => {
    // Leaving it in the book would leave every later surface — a workspace, a
    // terminal, a session it starts — free to open a shell as `ubuntu` again,
    // which is the thing this flow exists to end.
    expect(afterSaving("ubuntu@10.0.0.1:/srv", "mo", "mo@10.0.0.1:/srv")).toEqual({
      hold: "mo@10.0.0.1:/srv",
      forget: "ubuntu@10.0.0.1:/srv",
    });
  });

  test("re-saving as the same member forgets nothing", () => {
    // The wizard re-saves whenever a field changes, and forgetting the row we
    // just wrote would delete the machine out from under the flow.
    expect(afterSaving("mo@10.0.0.1:/srv", "mo", "mo@10.0.0.1:/srv")).toEqual({
      hold: "mo@10.0.0.1:/srv",
      forget: null,
    });
  });

  test("before there is a member, the bootstrap address is held, not overwritten", () => {
    // This is the subtle one. The wizard saves several times on the way through
    // — a name change, a box-kind change — and each of those arrives before the
    // member exists. Replacing the held id then would lose the one address that
    // needs dropping later, and the shared login would stay in the book
    // forever, working perfectly, for anyone who opened that machine.
    expect(afterSaving("ubuntu@10.0.0.1:/srv", null, "ubuntu@10.0.0.1:/srv")).toEqual({
      hold: "ubuntu@10.0.0.1:/srv",
      forget: null,
    });
  });

  test("on a box of your own nothing is ever forgotten", () => {
    // There is no shared login to drop: the login you connected as is yours.
    const first = afterSaving(null, null, "mo@10.0.0.1:/srv");
    expect(first.forget).toBe(null);
    expect(afterSaving(first.hold, null, "mo@10.0.0.1:/srv").forget).toBe(null);
  });
});
