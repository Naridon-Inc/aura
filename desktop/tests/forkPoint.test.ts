// "Fork chat" with no message picked branches at the latest settled reply.

import { describe, expect, test } from "bun:test";

import type { ChatTurn } from "../src/lib/api";
import { latestSettledTurnIndex } from "../src/lib/forkPoint";

const t = (role: ChatTurn["role"], text = ""): ChatTurn => ({ role, text, at: 0 });

describe("latestSettledTurnIndex", () => {
  test("the last reply when the chat ends on one", () => {
    expect(latestSettledTurnIndex([t("user"), t("manager"), t("user"), t("manager")])).toBe(3);
  });

  test("skips a trailing unanswered user turn", () => {
    expect(latestSettledTurnIndex([t("user"), t("manager"), t("user")])).toBe(1);
  });

  test("a system turn counts as settled", () => {
    expect(latestSettledTurnIndex([t("user"), t("system")])).toBe(1);
  });

  test("-1 with nothing to branch from", () => {
    expect(latestSettledTurnIndex([])).toBe(-1);
    expect(latestSettledTurnIndex(undefined)).toBe(-1);
    expect(latestSettledTurnIndex([t("user")])).toBe(-1);
  });
});
