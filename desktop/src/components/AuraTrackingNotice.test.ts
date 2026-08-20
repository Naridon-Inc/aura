import { describe, expect, test } from "bun:test";

import {
  idleAttempt,
  noticeCopy,
  pressTurnOn,
  type TrackAttempt,
  type TrackDeps,
} from "./AuraTrackingNotice";
import type { AuraCliCheck, AuraTrackStatus } from "../lib/api";

// The bug these exist for, from a screenshot on a stranger's Ubuntu box:
//
//   ● Aura off   Still off after trying — Aura couldn't switch on for this
//                project. It said: error: unr…      [Try again]  [×]
//
// The machine had a 0.7.2 `aura` in /usr/local/bin. `aura enable` didn't exist
// until three months after that release, so the helper answered `error:
// unrecognized subcommand 'enable'`, the strip clipped it to `error: unr…`, and
// Try again re-ran the same missing subcommand forever. Nothing on screen ever
// changed, so a button that really was firing read as dead.

/** A failed answer from `aura_ensure_tracked`. */
function offStatus(over: Partial<AuraTrackStatus> = {}): AuraTrackStatus {
  return {
    repo_root: "/home/sam/proj",
    is_git: true,
    tracked: false,
    newly_enabled: false,
    wired: false,
    detail: "Aura couldn't switch on for this project. It said: error: unrecognized subcommand 'enable'",
    stale_cli: null,
    raw_detail: "error: unrecognized subcommand 'enable'",
    ...over,
  };
}

function onStatus(): AuraTrackStatus {
  return {
    repo_root: "/home/sam/proj",
    is_git: true,
    tracked: true,
    newly_enabled: true,
    wired: true,
    detail: null,
    stale_cli: null,
    raw_detail: null,
  };
}

function check(): AuraCliCheck {
  return {
    installed: "0.19.36",
    expected: "0.19.36",
    path: "/home/sam/.local/bin/aura",
    status: "ok",
    raw: "aura 0.19.36",
    shadowing: null,
  };
}

/** Deps that count what the press actually reached for. */
function spyDeps(over: Partial<TrackDeps> = {}) {
  const calls = { ensure: 0, gitInit: 0, install: 0, authorized: [] as boolean[] };
  const deps: TrackDeps = {
    ensureTracked: async () => {
      calls.ensure += 1;
      return offStatus();
    },
    gitInitAndTrack: async () => {
      calls.gitInit += 1;
      return onStatus();
    },
    installCli: async (interactive) => {
      calls.install += 1;
      calls.authorized.push(interactive === true);
      return check();
    },
    ...over,
  };
  return { deps, calls };
}

/** The exact state the screenshot is in: one press already made, still off. */
function stillOffAfterTrying(over: Partial<AuraTrackStatus> = {}): TrackAttempt {
  return {
    status: offStatus(over),
    error: null,
    attempts: 1,
    needsPassword: false,
  };
}

describe("a press from the 'still off after trying' state", () => {
  test("really re-runs the attempt — no guard, no early return", async () => {
    const { deps, calls } = spyDeps();
    const prev = stillOffAfterTrying();

    const next = await pressTurnOn(deps, "/home/sam/proj", prev);

    expect(calls.ensure).toBe(1);
    expect(next.attempts).toBe(2);
  });

  test("presses keep landing — a fourth try calls out a fourth time", async () => {
    const { deps, calls } = spyDeps();
    let state: TrackAttempt = stillOffAfterTrying();
    for (let i = 0; i < 3; i++) {
      state = await pressTurnOn(deps, "/home/sam/proj", state);
    }
    expect(calls.ensure).toBe(3);
    expect(state.attempts).toBe(4);
  });

  test("the line changes on every press, so the button can't read as dead", async () => {
    const { deps } = spyDeps();
    let state: TrackAttempt = { ...idleAttempt, status: offStatus() };
    const lines: string[] = [noticeCopy(state).line];
    for (let i = 0; i < 3; i++) {
      state = await pressTurnOn(deps, "/home/sam/proj", state);
      lines.push(noticeCopy(state).line);
    }
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines[1]).toContain("Still off after trying");
    expect(lines[3]).toContain("3 tries");
  });

  test("a press that succeeds reports the success, not the old failure", async () => {
    const { deps } = spyDeps({ ensureTracked: async () => onStatus() });
    const next = await pressTurnOn(deps, "/home/sam/proj", stillOffAfterTrying());
    expect(next.status?.tracked).toBe(true);
    expect(next.error).toBeNull();
  });

  test("a press that throws still leaves a mark, and counts", async () => {
    const { deps } = spyDeps({
      ensureTracked: async () => {
        throw new Error("Not a directory: /home/sam/proj\nsecond line");
      },
    });
    const next = await pressTurnOn(deps, "/home/sam/proj", stillOffAfterTrying());
    expect(next.attempts).toBe(2);
    expect(next.error).toBe("Not a directory: /home/sam/proj");
    expect(noticeCopy(next).line).toContain("Not a directory");
  });
});

describe("an out-of-date helper is treated as a different problem", () => {
  const stale = {
    stale_cli: {
      installed: "0.7.2",
      expected: "0.19.36",
      path: "/usr/local/bin/aura",
    },
    // Verbatim from `explain_failure` in cmd_aura_track.rs — if that line
    // stops leading with the two numbers, the clip test below is the alarm.
    detail:
      "Aura's helper on this computer is version 0.7.2 and this app needs 0.19.36. The old one can't switch tracking on — updating it fixes this.",
  };

  test("the button offers the update, never a retry that cannot work", () => {
    const copy = noticeCopy(stillOffAfterTrying(stale));
    expect(copy.cta).toBe("Update to 0.19.36");
    expect(copy.cta).not.toContain("Try again");
  });

  test("pressing it replaces the helper first, then runs the attempt", async () => {
    const { deps, calls } = spyDeps();
    const next = await pressTurnOn(
      deps,
      "/home/sam/proj",
      stillOffAfterTrying(stale),
    );
    expect(calls.install).toBe(1);
    expect(calls.ensure).toBe(1);
    expect(next.cliCheck?.installed).toBe("0.19.36");
  });

  test("both version numbers survive the one-line clip", () => {
    const head = noticeCopy(stillOffAfterTrying(stale)).line.slice(0, 110);
    expect(head).toContain("0.7.2");
    expect(head).toContain("0.19.36");
  });

  test("a root-owned install dir asks for the password instead of failing", async () => {
    const { deps } = spyDeps({
      installCli: async () => {
        throw new Error("needs authorization: /usr/local/bin is not writable by your user");
      },
    });
    const next = await pressTurnOn(
      deps,
      "/home/sam/proj",
      stillOffAfterTrying(stale),
    );
    expect(next.needsPassword).toBe(true);
    expect(noticeCopy(next).cta).toBe("Enter password");
  });

  test("the password press re-runs the update, this time allowed to ask", async () => {
    const { deps, calls } = spyDeps();
    const denied: TrackAttempt = {
      status: offStatus(stale),
      error: "Updating Aura's helper needs your computer's administrator password.",
      attempts: 2,
      needsPassword: true,
    };
    await pressTurnOn(deps, "/home/sam/proj", denied, true);
    expect(calls.authorized).toEqual([true]);
    expect(calls.ensure).toBe(1);
  });

  test("the full message and the manual command are both reachable", () => {
    const copy = noticeCopy(stillOffAfterTrying(stale));
    expect(copy.details).toContain("/usr/local/bin/aura");
    expect(copy.details).toContain("unrecognized subcommand 'enable'");
    expect(copy.showInstallCommand).toBe(true);
  });
});

describe("the strip stays honest about the other states", () => {
  test("a folder that isn't a repo yet offers the one-click setup", async () => {
    const { deps, calls } = spyDeps();
    const prev: TrackAttempt = {
      status: offStatus({
        is_git: false,
        detail: "This folder isn't a Git repository yet.",
        raw_detail: null,
      }),
      error: null,
      attempts: 0,
      needsPassword: false,
    };
    expect(noticeCopy(prev).cta).toBe("Turn on Aura");
    await pressTurnOn(deps, "/home/sam/proj", prev);
    expect(calls.gitInit).toBe(1);
    expect(calls.ensure).toBe(0);
  });

  test("the automatic pass on open is not reported as a failed try", () => {
    const copy = noticeCopy({ ...idleAttempt, status: offStatus() });
    expect(copy.line).not.toContain("Still off after");
  });

  test("nothing extra to show means no Details button to press", () => {
    const copy = noticeCopy({
      ...idleAttempt,
      status: offStatus({ raw_detail: null }),
    });
    expect(copy.details).toBeNull();
    expect(copy.showInstallCommand).toBe(false);
  });

  test("a helper that won't start still points at installing one", () => {
    const copy = noticeCopy({
      ...idleAttempt,
      status: offStatus({
        detail: "Aura's helper program isn't installed on this computer, so there was nothing to switch on. Install it, then try again.",
        raw_detail: "couldn't start Aura (aura): No such file or directory",
      }),
    });
    expect(copy.showInstallCommand).toBe(true);
  });
});
