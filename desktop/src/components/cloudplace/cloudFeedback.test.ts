import { describe, expect, test } from "bun:test";

import { feedbackPage, type CommentDto } from "../../lib/cloudFeedbackApi";
import {
  EMPTY_FEEDBACK,
  commentCount,
  commentText,
  inboxKind,
  isOwn,
  noticeLine,
  readGate,
  saidLine,
  threadLine,
  threadsOf,
  turnIdOf,
  turnIdsByKey,
  withComment,
  withFrame,
  withPage,
} from "./cloudFeedback";

const note = (id: string, over: Partial<CommentDto> = {}): CommentDto => ({
  id,
  message_id: "m1",
  message_key: null,
  parent_id: null,
  author_id: "u-priya",
  author_name: "Priya",
  body: `body ${id}`,
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
  edited_at: null,
  deleted: false,
  resolved_at: null,
  resolved_by: null,
  ...over,
});

describe("merging what the cloud sends", () => {
  test("a page merges comments by id and moves the cursor on", () => {
    const before = withComment(EMPTY_FEEDBACK, note("c0"));
    const next = withPage(before, { comments: [note("c1")], as_of: "2026-11-11T10:05:00Z", more: false });
    expect(Object.keys(next.comments).sort()).toEqual(["c0", "c1"]);
    expect(next.comments.c1.body).toBe("body c1");
    expect(next.asOf).toBe("2026-11-11T10:05:00Z");
    expect(next.read).toBe(true);
  });

  test("a page with no cursor keeps the one held", () => {
    const held = { ...EMPTY_FEEDBACK, asOf: "2026-11-11T09:00:00Z" };
    expect(withPage(held, { comments: [], as_of: null, more: false }).asOf).toBe("2026-11-11T09:00:00Z");
  });

  test("a comment seen again at the cursor changes nothing; an older copy never wins", () => {
    const edited = note("c1", { body: "new words", updated_at: "2026-11-11T10:03:00Z" });
    let s = withComment(EMPTY_FEEDBACK, edited);
    s = withComment(s, edited);
    expect(s.comments.c1.body).toBe("new words");
    s = withComment(s, note("c1", { body: "old words", updated_at: "2026-11-11T10:01:00Z" }));
    expect(s.comments.c1.body).toBe("new words");
  });

  test("a comment frame merges; other frames and broken ones leave the state alone", () => {
    const s = withFrame(EMPTY_FEEDBACK, { kind: "feedback", op: "comment", comment: note("c9") });
    expect(s.comments.c9).toBeDefined();
    expect(withFrame(s, { kind: "message", id: "x" })).toBe(s);
    expect(withFrame(s, { kind: "feedback", op: "comment", comment: { body: "no id" } })).toBe(s);
    expect(withFrame(s, null)).toBe(s);
  });

  test("the reactions the cloud still sends are left unread", () => {
    const s = withComment(EMPTY_FEEDBACK, note("c1"));
    const frame = { kind: "feedback", op: "reaction", message_id: "m1", reactions: [{ message_id: "m1", emoji: "👍", user_id: "u-sam" }] };
    expect(withFrame(s, frame)).toBe(s);
    const page = feedbackPage({
      reactions: [{ message_id: "m1", emoji: "👍", user_id: "u-sam" }],
      comments: [{ id: "c2", message_id: "m1", body: "hi" }],
      as_of: null,
    });
    expect(Object.keys(page).sort()).toEqual(["as_of", "comments", "more"]);
    expect(page.comments.map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("threads", () => {
  const comments = {
    c1: note("c1", { created_at: "2026-11-11T10:00:00Z" }),
    r1: note("r1", { parent_id: "c1", author_id: "u-sam", author_name: "Sam", created_at: "2026-11-11T10:02:00Z" }),
    r0: note("r0", { parent_id: "c1", created_at: "2026-11-11T10:01:00Z" }),
    c2: note("c2", { message_id: "m2", created_at: "2026-11-11T09:00:00Z" }),
    w1: note("w1", { message_id: null }),
    gone: note("gone", { deleted: true, body: "" }),
    half: note("half", { deleted: true, body: "", message_id: "m2", created_at: "2026-11-11T11:00:00Z" }),
    kept: note("kept", { parent_id: "half", author_id: "u-sam", author_name: "Sam" }),
  };

  test("grouped by turn, replies under their start, oldest first", () => {
    const t = threadsOf(comments);
    expect(t.byTurn.m1.map((x) => x.root.id)).toEqual(["c1"]);
    expect(t.byTurn.m1[0].replies.map((r) => r.id)).toEqual(["r0", "r1"]);
    expect(t.byTurn.m2.map((x) => x.root.id)).toEqual(["c2", "half"]);
    expect(t.workspace.map((x) => x.root.id)).toEqual(["w1"]);
  });

  test("a thread nothing is left of is gone; one with a live reply stays", () => {
    const t = threadsOf(comments);
    expect(Object.values(t.byTurn).flat().some((x) => x.root.id === "gone")).toBe(false);
    const half = t.byTurn.m2.find((x) => x.root.id === "half")!;
    expect(commentText(half.root)).toBe("Comment deleted");
    expect(commentCount([half])).toBe(1);
  });

  test("a folded thread's line counts what is left and names who wrote", () => {
    const t = threadsOf(comments);
    expect(threadLine(t.byTurn.m1, null)).toBe("3 comments · Priya, Sam");
    expect(threadLine(t.byTurn.m1, "u-sam")).toBe("3 comments · Priya, You");
    expect(threadLine([t.workspace[0]], null)).toBe("1 comment · Priya");
  });

  test("only your own, live comments are yours to change", () => {
    expect(isOwn(comments.c1, "u-priya")).toBe(true);
    expect(isOwn(comments.c1, "u-sam")).toBe(false);
    expect(isOwn(comments.gone, "u-priya")).toBe(false);
    expect(isOwn(comments.c1, null)).toBe(false);
  });
});

describe("the driver's own copy of a machine chat", () => {
  const s = withComment(
    withComment(EMPTY_FEEDBACK, note("c0", { message_id: "cloud-a", message_key: "t1-a" })),
    note("c1", { message_id: "cloud-u", message_key: "t1-u" }),
  );

  test("keys come from the comments and what the relay kept", () => {
    expect(turnIdsByKey(s, { "t2-a": "cloud-b" })).toEqual({ "t2-a": "cloud-b", "t1-a": "cloud-a", "t1-u": "cloud-u" });
  });

  test("a comment on the workspace, with no turn, names no turn", () => {
    const w = withComment(EMPTY_FEEDBACK, note("w1", { message_id: null, message_key: "t9" }));
    expect(turnIdsByKey(w)).toEqual({});
  });

  test("a turn filed from the log carries its id; a sent one is found by its key; anything else gets nothing", () => {
    const ids = turnIdsByKey(s);
    expect(turnIdOf({ cloud_id: "filed" }, ids)).toBe("filed");
    expect(turnIdOf({ cloud_key: "t1-a" }, ids)).toBe("cloud-a");
    expect(turnIdOf({ cloud_key: "never-sent" }, ids)).toBeNull();
    expect(turnIdOf({}, ids)).toBeNull();
  });
});

describe("notifications and hand-offs", () => {
  test("each kind of inbox row says what happened, where", () => {
    expect(noticeLine("mention", "Priya", "HI")).toBe("Priya mentioned you in HI");
    expect(noticeLine("reply", "Priya", "HI")).toBe("Priya replied in HI");
    expect(noticeLine("comment", "Priya", "HI")).toBe("Priya commented on your message in HI");
    expect(noticeLine("reply", " ", "")).toBe("Someone replied in a thread you’re in");
    expect(noticeLine("comment", "Sam", null)).toBe("Sam commented on your message");
    expect(noticeLine("mention", "Sam", null)).toBe("Sam mentioned you");
  });

  test("an unknown kind is read as a mention, as rows before comments were", () => {
    expect(inboxKind(undefined)).toBe("mention");
    expect(inboxKind("reply")).toBe("reply");
    expect(inboxKind("poke")).toBe("mention");
  });

  test("a comment handed to the agent says who said it", () => {
    expect(saidLine("Priya", "  make the button green ")).toBe("Priya said: make the button green");
    expect(saidLine(null, "hi")).toBe("A teammate said: hi");
  });
});

describe("reads", () => {
  test("a read left over from before the workspace reopened never holds off the next one", () => {
    const gate = readGate();
    expect(gate.begin(1)).toBe(true);
    // Opened again (or mounted twice) while the first read is still out.
    expect(gate.begin(2)).toBe(true);
    expect(gate.begin(2)).toBe(false);
    // The old read lands and finishes: the new one stays under way.
    gate.end(1);
    expect(gate.begin(2)).toBe(false);
    gate.end(2);
    expect(gate.begin(2)).toBe(true);
  });
});
