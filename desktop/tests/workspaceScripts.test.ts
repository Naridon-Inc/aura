import { beforeEach, describe, expect, it } from "bun:test";

import {
  archiveNotice,
  EMPTY_VIEW,
  LOG_KEEP_CHARS,
  applyScriptEvent,
  fixSetupScriptPrompt,
  plainLog,
  reduceScriptEvent,
  resetWorkspaceScriptsForTest,
  scriptView,
  setupFace,
  setupStatusLabel,
  subscribeScript,
  unseenOutput,
  type ScriptRun,
  type ScriptStatus,
} from "../src/lib/workspaceScripts";

function run(status: ScriptStatus, startedAt = 1): ScriptRun {
  return {
    kind: "setup",
    worktreePath: "/w/otter",
    command: "bun install",
    status,
    startedAt,
    endedAt: null,
    exitCode: null,
    reason: null,
  };
}

const ev = (over: Partial<{ chunk: string | null; run: ScriptRun | null }>) => ({
  worktreePath: "/w/otter",
  kind: "setup" as const,
  chunk: null,
  run: null,
  ...over,
});

describe("reduceScriptEvent", () => {
  it("appends output to the run it belongs to", () => {
    let v = reduceScriptEvent(EMPTY_VIEW, ev({ run: run("running") }));
    v = reduceScriptEvent(v, ev({ chunk: "Copied .env\n" }));
    v = reduceScriptEvent(v, ev({ chunk: "installing\n" }));
    v = reduceScriptEvent(v, ev({ run: { ...run("failed"), exitCode: 1 } }));
    expect(v.log).toBe("Copied .env\ninstalling\n");
    expect(v.run?.status).toBe("failed");
  });

  it("a rerun starts a new log", () => {
    let v = reduceScriptEvent(EMPTY_VIEW, ev({ run: run("failed", 1) }));
    v = reduceScriptEvent(v, ev({ chunk: "old\n" }));
    v = reduceScriptEvent(v, ev({ run: run("running", 2) }));
    expect(v.log).toBe("");
    v = reduceScriptEvent(v, ev({ chunk: "new\n" }));
    expect(v.log).toBe("new\n");
  });

  it("keeps only the end of a very long log", () => {
    const big = "x".repeat(LOG_KEEP_CHARS);
    let v = reduceScriptEvent(EMPTY_VIEW, ev({ run: run("running") }));
    v = reduceScriptEvent(v, ev({ chunk: big }));
    v = reduceScriptEvent(v, ev({ chunk: "tail" }));
    expect(v.log.length).toBe(LOG_KEEP_CHARS);
    expect(v.log.endsWith("tail")).toBe(true);
  });
});

describe("setup faces and labels", () => {
  it("picks run, stop or rerun", () => {
    expect(setupFace(null)).toBe("run");
    expect(setupFace(run("running"))).toBe("stop");
    expect(setupFace(run("stopping"))).toBe("stop");
    expect(setupFace(run("completed"))).toBe("rerun");
    expect(setupFace(run("did_not_start"))).toBe("rerun");
  });

  it("says how setup stands", () => {
    expect(setupStatusLabel(null)).toBeNull();
    expect(setupStatusLabel(run("running"))).toBe("Setting up...");
    expect(setupStatusLabel(run("completed"))).toBe("Setup succeeded");
    expect(setupStatusLabel(run("failed"))).toBe("Setup failed");
    expect(setupStatusLabel(run("did_not_start"))).toBe("Setup failed");
  });
});

describe("plainLog", () => {
  it("drops colour codes and keeps a progress bar's last state", () => {
    expect(plainLog("\u001b[32mok\u001b[0m\r\n")).toBe("ok\n");
    expect(plainLog("10%\r50%\r100%\ndone")).toBe("100%\ndone");
  });
});

describe("the shared view", () => {
  beforeEach(() => resetWorkspaceScriptsForTest());

  it("tells subscribers of the same workspace, keyed without a trailing slash", () => {
    let calls = 0;
    const off = subscribeScript("/w/otter/", "setup", () => calls++);
    applyScriptEvent(ev({ run: run("running") }));
    applyScriptEvent(ev({ chunk: "hi\n" }));
    applyScriptEvent({ ...ev({ chunk: "other\n" }), worktreePath: "/w/fox" });
    expect(calls).toBe(2);
    expect(scriptView("/w/otter", "setup").log).toBe("hi\n");
    expect(scriptView("/w/otter", "archive")).toBe(EMPTY_VIEW);
    off();
    applyScriptEvent(ev({ chunk: "more\n" }));
    expect(calls).toBe(2);
  });
});

describe("unseenOutput", () => {
  it("hands a viewer only what it hasn't drawn, or everything after a reset", () => {
    let v = reduceScriptEvent(EMPTY_VIEW, ev({ run: run("running") }));
    v = reduceScriptEvent(v, ev({ chunk: "one\n" }));
    const drawn = { gen: v.gen, total: v.total };
    v = reduceScriptEvent(v, ev({ chunk: "two\n" }));
    expect(unseenOutput(v, drawn)).toEqual({ reset: false, text: "two\n" });
    expect(unseenOutput(v, { gen: v.gen, total: v.total })).toEqual({ reset: false, text: "" });
    const rerun = reduceScriptEvent(v, ev({ run: run("running", 9) }));
    expect(unseenOutput(rerun, { gen: v.gen, total: v.total }).reset).toBe(true);
  });

  it("redraws when more arrived than is kept", () => {
    let v = reduceScriptEvent(EMPTY_VIEW, ev({ run: run("running") }));
    const drawn = { gen: v.gen, total: v.total };
    v = reduceScriptEvent(v, ev({ chunk: "y".repeat(LOG_KEEP_CHARS + 10) }));
    expect(unseenOutput(v, drawn).reset).toBe(true);
  });
});

describe("fixSetupScriptPrompt", () => {
  it("names the script and attaches the plain log", () => {
    const text = fixSetupScriptPrompt("bun install", "\u001b[31merror\u001b[0m: lockfile\n");
    expect(text).toContain("The user's setup script failed.");
    expect(text).toContain("The setup script is: `bun install`.");
    expect(text.endsWith("Setup logs:\nerror: lockfile")).toBe(true);
  });

  it("leaves the script line out when there is none", () => {
    expect(fixSetupScriptPrompt(null, "x")).not.toContain("The setup script is");
  });
});

describe("archiveNotice", () => {
  const run = (over: Partial<ScriptRun>): ScriptRun => ({
    kind: "archive",
    worktreePath: "/w",
    command: "make clean",
    status: "completed",
    startedAt: 1,
    endedAt: 2,
    exitCode: 0,
    reason: null,
    ...over,
  });
  it("quiet when it went fine or there was no script", () => {
    expect(archiveNotice(null)).toBeNull();
    expect(archiveNotice(run({}))).toBeNull();
  });
  it("names the command and its exit code when it failed", () => {
    expect(archiveNotice(run({ status: "failed", exitCode: 2 }))).toEqual({
      title: "Archive script failed",
      body: "make clean exited with code 2",
    });
  });
  it("passes on why it did not run", () => {
    expect(archiveNotice(run({ status: "did_not_start", reason: "not trusted" }))).toEqual({
      title: "Archive script didn't run",
      body: "not trusted",
    });
  });
});
