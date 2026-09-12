import { describe, expect, it } from "bun:test";
import { parseSessionAppLink } from "@shared/sessionLink";
import type { IntentRow } from "../src/lib/api";
import {
  handoffProblem,
  resolveHandoff,
  rewindPath,
  rowForSession,
} from "../src/lib/sessionHandoff";

function row(p: Partial<IntentRow> & { timestamp: number }): IntentRow {
  return {
    agent_id: "claude",
    intent: "did a thing",
    ...p,
  } as IntentRow;
}

const HERE = "/Users/x/code/aura-sovereign";
const KNOWN = { roots: [HERE, "/Users/x/code/other"], standingIn: HERE };

describe("the row that stands for a session", () => {
  it("finds the session by the id its notes were stamped with", () => {
    const rows = [
      row({ timestamp: 20, session_id: "other" }),
      row({ timestamp: 10, claude_session_id: "s1", intent: "wire the roster" }),
    ];
    expect(rowForSession(rows, "s1")?.intent).toBe("wire the roster");
  });

  it("prefers what someone wrote over what a hook captured", () => {
    // A hook row's text is the command it ran. Opening a session on one of
    // those titles the whole record with a shell line.
    const rows = [
      row({ timestamp: 5, session_id: "s1", intent: "[auto] claude edited 3 files" }),
      row({ timestamp: 30, session_id: "s1", intent: "make the roster name people" }),
    ];
    expect(rowForSession(rows, "s1")?.intent).toBe("make the roster name people");
  });

  it("takes the first of two rows of the same kind", () => {
    // What a session set out to do is said at the start, not at the end.
    const rows = [
      row({ timestamp: 30, session_id: "s1", intent: "and then this" }),
      row({ timestamp: 10, session_id: "s1", intent: "this first" }),
    ];
    expect(rowForSession(rows, "s1")?.intent).toBe("this first");
  });

  it("answers for an Aura chat, which stamps its id somewhere else", () => {
    const rows = [row({ timestamp: 10, manager_session_id: "m1", intent: "chatted" })];
    expect(rowForSession(rows, "m1")?.intent).toBe("chatted");
  });

  it("has nothing to say about a session it never saw", () => {
    expect(rowForSession([row({ timestamp: 1, session_id: "s1" })], "s2")).toBeNull();
    expect(rowForSession([], "s1")).toBeNull();
    expect(rowForSession([row({ timestamp: 1, session_id: "s1" })], "  ")).toBeNull();
  });
});

describe("where an incoming link lands", () => {
  const rows = [row({ timestamp: 10, session_id: "s1", intent: "the work" })];

  const log = async () => rows;

  it("opens the session in the project the link named", async () => {
    const link = parseSessionAppLink("aura://session/s1?repo=MHASK%2Faura-sovereign")!;
    expect(await resolveHandoff(link, KNOWN, log)).toMatchObject({
      kind: "open",
      root: HERE,
      rewind: null,
    });
  });

  it("carries a file the link asked to bring back", async () => {
    const link = parseSessionAppLink("aura://session/s1?rewind=src%2Fmain.rs")!;
    const h = await resolveHandoff(link, KNOWN, log);
    expect(h.kind === "open" && h.rewind).toBe("src/main.rs");
    expect(rewindPath(HERE, "src/main.rs")).toBe(`${HERE}/src/main.rs`);
  });

  it("says which project is missing rather than opening the one at hand", async () => {
    const link = parseSessionAppLink("aura://session/s1?repo=someone%2Felse")!;
    const h = await resolveHandoff(link, KNOWN, log);
    expect(h.kind).toBe("no-project");
    expect(handoffProblem(h)).toContain("else");
  });

  it("distinguishes a project it lacks from a session it lacks", async () => {
    const link = parseSessionAppLink("aura://session/ran-elsewhere")!;
    const h = await resolveHandoff(link, KNOWN, log);
    expect(h.kind).toBe("no-session");
    // The record is not lost — it is in the console, where the link came from.
    expect(handoffProblem(h)).toContain("console");
  });

  it("only reads the log of the checkout it settled on", async () => {
    const asked: string[] = [];
    const link = parseSessionAppLink("aura://session/s1")!;
    await resolveHandoff(link, KNOWN, async (root) => {
      asked.push(root);
      return rows;
    });
    expect(asked).toEqual([HERE]);
  });

  it("reports a missing session rather than throwing an unreadable log", async () => {
    const link = parseSessionAppLink("aura://session/s1")!;
    const h = await resolveHandoff(link, KNOWN, async () => {
      throw new Error("permission denied");
    });
    expect(h.kind).toBe("no-session");
  });

  it("has no problem to report once it has opened something", async () => {
    const link = parseSessionAppLink("aura://session/s1")!;
    expect(handoffProblem(await resolveHandoff(link, KNOWN, log))).toBe("");
  });

  it("leaves an already-absolute rewind path alone", () => {
    expect(rewindPath(HERE, "/tmp/x.rs")).toBe("/tmp/x.rs");
    expect(rewindPath(`${HERE}/`, "/src/a.rs".slice(1))).toBe(`${HERE}/src/a.rs`);
  });
});
