// Run with: bun test src/lib/pairComputer.test.ts
//
// The few sentences the add-a-computer screen says on its own.

import { describe, expect, test } from "bun:test";

import { computerLine, joinedNotes, minutesLeft, settled, waitingLine, type JoinReport } from "./pairComputer";

describe("a connected computer", () => {
  test("reads as its name, cores and memory", () => {
    expect(computerLine({ name: "build-box", cpus: 24, memory_gb: 188 })).toBe("build-box · 24 cores · 188 GB");
  });
  test("leaves out what it didn't say", () => {
    expect(computerLine({ name: "build-box", cpus: null, memory_gb: 16 })).toBe("build-box · 16 GB");
    expect(computerLine({ name: "Mac", cpus: 1, memory_gb: null })).toBe("Mac · 1 core");
    expect(computerLine({ name: "  ", cpus: 0, memory_gb: 0 })).toBe("Computer");
  });
});

describe("waiting", () => {
  test("only connected, expired and removed are the end of it", () => {
    expect(settled("waiting")).toBe(false);
    expect(settled("joining")).toBe(false);
    expect(settled("connected")).toBe(true);
    expect(settled("expired")).toBe(true);
    expect(settled("removed")).toBe(true);
  });
  test("each state has its own line", () => {
    expect(waitingLine("waiting")).toBe("Waiting for your computer…");
    expect(waitingLine("joining")).toBe("Your computer is connecting…");
    expect(waitingLine("expired")).toContain("ran out");
  });
  test("minutes left round up and stop at zero", () => {
    const now = Date.parse("2026-11-13T10:00:00Z");
    expect(minutesLeft("2026-11-13T10:10:00Z", now)).toBe(10);
    expect(minutesLeft("2026-11-13T10:00:30Z", now)).toBe(1);
    expect(minutesLeft("2026-11-13T09:59:00Z", now)).toBe(0);
    expect(minutesLeft("not a date", now)).toBe(0);
  });
});

describe("this computer, once joined", () => {
  const base: JoinReport = { ok: true, state: "connected", message: "Connected to Acme.", pair_id: "p" };
  test("asks for Claude Code when the service won't find it", () => {
    expect(joinedNotes({ ...base, agent_ready: false })).toEqual([
      "Install Claude Code on this computer so it can answer chats.",
    ]);
  });
  test("doesn't say it twice when aura join already did", () => {
    const said = "Claude Code isn't installed here yet.";
    expect(joinedNotes({ ...base, agent_ready: false, notes: [said] })).toEqual([said]);
  });
  test("says nothing extra when all is well", () => {
    expect(joinedNotes({ ...base, agent_ready: true })).toEqual([]);
  });
});
