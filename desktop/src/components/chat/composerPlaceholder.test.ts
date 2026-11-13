// Run with: bun test src/components/chat/composerPlaceholder.test.ts
//
// The empty box says what the next message will be. In goal mode it is a goal
// ("Set a goal"); while a plan is paused waiting for an answer it adjusts
// that plan ("Enter your plan adjustments here..."). A running turn's
// follow-up wording still comes first, and goal mode resets when the chat
// changes. Scanned: the wording is a chain in one expression and the plan
// flag is a prop the chat view has to pass.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("the composer's placeholder", () => {
  const composer = read("components/manager/ManagerComposer.tsx");

  test("goal mode, then a paused plan, then the host's wording", () => {
    expect(composer).toMatch(
      /: goalMode\s*\? "Set a goal"\s*: planAwaitingReply\s*\? "Enter your plan adjustments here\.\.\."\s*: \(placeholder \?\? "Ask to make changes, @mention files, run \/commands"\)/,
    );
  });

  test("goal mode resets when the chat changes", () => {
    expect(composer).toContain("useEffect(() => setGoalMode(false), [sessionId]);");
  });

  test("the chat view says when a plan is waiting", () => {
    expect(read("components/manager/ManagerChatView.tsx")).toContain(
      "planAwaitingReply={!!session.pending_plan}",
    );
  });
});
