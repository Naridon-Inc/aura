import { describe, expect, test } from "bun:test";

import {
  EMPTY_LIVE,
  liveStep,
  withMessage,
  withRead,
  type LiveFrame,
  type LiveState,
} from "./cloudWorkspaceLive";
import type { CloudMessageRow } from "./cloudWorkspacesApi";

let seq = 0;
const update = (update: Record<string, unknown>, at = ++seq): LiveFrame => ({
  kind: "acp_event",
  event: {
    seq: at,
    acp_session_id: "s-1",
    kind: "session/update",
    payload: { sessionId: "s-1", update },
  },
});
const event = (kind: string, payload: unknown, at = ++seq): LiveFrame => ({
  kind: "acp_event",
  event: { seq: at, acp_session_id: "s-1", kind, payload },
});
const message = (id: string, role: string, body = "x"): CloudMessageRow => ({
  id,
  role,
  body,
  source: null,
  created_at: "2026-11-10T00:00:00Z",
});
const fold = (frames: LiveFrame[], from: LiveState = EMPTY_LIVE) => frames.reduce(liveStep, from);

describe("a viewer following a workspace live", () => {
  test("sees the reply as it is written and each tool as it runs, in order", () => {
    const s = fold([
      { kind: "ready", viewers: 2 },
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Let me " },
      }),
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "look." },
      }),
      update({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read src/a.ts",
        status: "pending",
      }),
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
      }),
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done." },
      }),
    ]);
    expect(s.up).toBe(true);
    expect(s.viewers).toBe(2);
    expect(s.working).toBe(true);
    expect(s.steps).toEqual([
      { kind: "text", text: "Let me look." },
      { kind: "tool", id: "t1", title: "Read src/a.ts", status: "done" },
      { kind: "text", text: "Done." },
    ]);
  });

  test("a frame heard twice is folded once", () => {
    const chunk = update(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      },
      900,
    );
    expect(fold([chunk, chunk]).steps).toEqual([{ kind: "text", text: "hi" }]);
  });

  test("a failed tool says so", () => {
    const s = fold([
      update({
        sessionUpdate: "tool_call",
        toolCallId: "t2",
        title: "Run tests",
        status: "in_progress",
      }),
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t2",
        status: "failed",
      }),
    ]);
    expect(s.steps).toEqual([{ kind: "tool", id: "t2", title: "Run tests", status: "error" }]);
  });

  test("a question waits on the driver until it is answered", () => {
    const asked = fold([
      event("session/request_permission", {
        sessionId: "s-1",
        toolCall: { toolCallId: "t3", title: "Edit lib.rs" },
      }),
    ]);
    expect(asked.asking).toBe("Edit lib.rs");
    expect(
      fold(
        [
          event("_aura/permission_resolved", {
            requestId: 1,
            optionId: "allow",
          }),
        ],
        asked,
      ).asking,
    ).toBeNull();
  });

  test("the question shows while it is asked, and the answer ends the live turn", () => {
    const asked = fold([{ kind: "message", message: message("m1", "user", "fix it") }]);
    expect(asked.working).toBe(true);
    const writing = fold(
      [
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "On it" },
        }),
      ],
      asked,
    );
    const answered = fold(
      [
        {
          kind: "message",
          message: message("m2", "assistant", "On it. Fixed."),
        },
      ],
      writing,
    );
    expect(answered.working).toBe(false);
    expect(answered.steps).toEqual([]);
  });

  test("a dropped socket says why, and coming back starts the turn view afresh", () => {
    const busy = fold([
      { kind: "ready" },
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "half" },
      }),
    ]);
    const down = liveStep(busy, {
      kind: "down",
      reason: "the socket stopped answering",
    });
    expect(down.up).toBe(false);
    expect(down.reason).toBe("the socket stopped answering");
    const back = liveStep(down, { kind: "ready" });
    expect(back.up).toBe(true);
    expect(back.reason).toBeNull();
    expect(back.steps).toEqual([]);
  });

  test("a live message joins the list once, in place when it was already read", () => {
    const list = [message("m1", "user"), message("m2", "assistant", "old")];
    expect(withMessage(list, message("m3", "user"))?.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(withMessage(list, message("m2", "assistant", "new"))?.map((m) => m.body)).toEqual([
      "x",
      "new",
    ]);
    expect(withMessage(null, message("m1", "user"))).toBeNull();
  });

  test("a read taken before a live message landed doesn't lose it", () => {
    const later = {
      ...message("m3", "user"),
      created_at: "2026-11-10T00:00:09Z",
    };
    const shown = [message("m1", "user"), later];
    expect(withRead(shown, [message("m1", "user")]).map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(withRead(shown, [message("m1", "user"), later]).map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(withRead(null, [message("m1", "user")]).map((m) => m.id)).toEqual(["m1"]);
  });
});
