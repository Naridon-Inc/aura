import { describe, expect, test } from "bun:test";
import type { GraphCommit, PrComment, PrDetail } from "../../../lib/api";
import { gitChatFor } from "../../../lib/gitChatPrompts";
import {
  prActivity,
  prWorkflow,
  reviewerLabel,
  reviewThreads,
  riskMarkTone,
  stackOrder,
  type PrChecksTally,
} from "./prOverviewModel";

const PR = (over: Partial<PrDetail> = {}): PrDetail => ({
  number: 412,
  title: "Retry card charges",
  state: "OPEN",
  body: "",
  author: "dana",
  head_ref: "fix/charge-retry",
  base_ref: "main",
  is_draft: false,
  mergeable: "MERGEABLE",
  additions: 42,
  deletions: 3,
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-02T10:00:00Z",
  review_decision: null,
  url: "https://github.com/acme/pay/pull/412",
  files: [],
  diff: "",
  aura_review: null,
  reviewers: [],
  assignees: [],
  merged_by: null,
  merged_at: null,
  related_issues: [],
  ...over,
});

const CHECKS = (over: Partial<PrChecksTally> = {}): PrChecksTally => ({
  state: "success",
  passing: 3,
  failing: 0,
  pending: 0,
  total: 3,
  ...over,
});

const COMMENT = (over: Partial<PrComment> = {}): PrComment => ({
  id: 1,
  node_id: "n1",
  author: "sam",
  body: "Looks good",
  created_at: "2026-11-01T12:00:00Z",
  updated_at: "2026-11-01T12:00:00Z",
  path: null,
  line: null,
  start_line: null,
  side: null,
  in_reply_to: null,
  is_issue_comment: true,
  thread_node_id: null,
  thread_resolved: false,
  reactions: [],
  ...over,
});

describe("the one next step a pull request offers", () => {
  test("a finished PR is only archived", () => {
    expect(prWorkflow(PR({ state: "MERGED" }), CHECKS({ failing: 2 }), "mo", []).state).toBe("merged");
    expect(prWorkflow(PR({ state: "CLOSED" }), null, "mo", []).state).toBe("closed");
  });

  test("a draft is made ready before anything else", () => {
    expect(prWorkflow(PR({ is_draft: true, mergeable: "CONFLICTING" }), null, "mo", []).state).toBe("draft");
  });

  test("a conflict, then a red check, block before a review", () => {
    const pr = PR({ review_decision: "REVIEW_REQUIRED" });
    expect(prWorkflow({ ...pr, mergeable: "CONFLICTING" }, CHECKS({ failing: 1 }), "mo", []).state).toBe(
      "unable-to-merge",
    );
    const failing = prWorkflow(pr, CHECKS({ failing: 1 }), "mo", []);
    expect(failing.state).toBe("checks-failing");
    // Nothing here fixes a check, so the step is to read them.
    expect(failing.hasFixableChecks).toBe(false);
  });

  test("changes requested offers the comments only when there are some", () => {
    const pr = PR({ review_decision: "CHANGES_REQUESTED" });
    expect(prWorkflow(pr, CHECKS(), "mo", [COMMENT()]).hasPendingComments).toBe(true);
    expect(prWorkflow(pr, CHECKS(), "mo", [COMMENT({ body: "  " })]).hasPendingComments).toBe(false);
  });

  test("approve is for someone other than the author, once we know who is looking", () => {
    const pr = PR({ review_decision: "REVIEW_REQUIRED" });
    expect(prWorkflow(pr, CHECKS(), "mo", []).state).toBe("approve-pr");
    expect(prWorkflow(pr, CHECKS(), "dana", []).state).toBe("review-required");
    expect(prWorkflow(pr, CHECKS(), "", []).state).toBe("review-required");
  });

  test("pending checks only hold up an otherwise ready merge", () => {
    expect(prWorkflow(PR(), CHECKS({ pending: 1 }), "mo", []).state).toBe("checks-pending");
    expect(prWorkflow(PR(), CHECKS(), "mo", []).state).toBe("ready");
    expect(prWorkflow(PR(), null, "mo", []).state).toBe("ready");
  });

  test("the counts ride along for the label", () => {
    const w = prWorkflow(PR(), CHECKS({ failing: 1, total: 4 }), "mo", []);
    expect([w.prNumber, w.branch, w.targetBranch, w.failedChecks, w.totalChecks]).toEqual([
      412,
      "fix/charge-retry",
      "main",
      1,
      4,
    ]);
  });
});

describe("what the details list says", () => {
  test("a reviewer carries their verdict once given", () => {
    expect(reviewerLabel({ login: "lee", state: "COMMENTED" })).toBe("lee (commented)");
    expect(reviewerLabel({ login: "lee", state: "APPROVED" })).toBe("lee (approved)");
    expect(reviewerLabel({ login: "lee", state: "CHANGES_REQUESTED" })).toBe("lee (changes requested)");
    expect(reviewerLabel({ login: "sam", state: "PENDING" })).toBe("sam");
  });

  test("threads are root comments on lines of the diff", () => {
    const roots = [
      COMMENT({ id: 1, is_issue_comment: false, path: "a.ts", line: 3 }),
      COMMENT({ id: 2, is_issue_comment: false, path: "a.ts", line: 9, thread_resolved: true }),
      COMMENT({ id: 3, is_issue_comment: false, path: "a.ts", line: 3, in_reply_to: 1 }),
      COMMENT({ id: 4 }),
    ];
    expect(reviewThreads(roots)).toEqual({ total: 2, unresolved: 1 });
  });

  test("risk reads as a mark tone", () => {
    expect([riskMarkTone(10), riskMarkTone(40), riskMarkTone(70)]).toEqual(["good", "warn", "danger"]);
  });
});

describe("everything that happened, newest first", () => {
  const commit: GraphCommit = {
    sha: "abc1234def",
    short: "abc1234",
    parents: [],
    author: "dana",
    author_email: "",
    timestamp: Date.parse("2026-11-01T11:00:00Z") / 1000,
    subject: "add backoff",
    refs: [],
  };

  test("opened, commits, comments and the merge, in time order", () => {
    const list = prActivity(
      PR({ state: "MERGED", merged_at: "2026-11-03T09:00:00Z", merged_by: "lee" }),
      [
        COMMENT({ id: 7, created_at: "2026-11-01T12:00:00Z" }),
        COMMENT({ id: 8, body: "", created_at: "2026-11-01T13:00:00Z" }),
        COMMENT({
          id: 9,
          is_issue_comment: false,
          path: "src/pay/charge.ts",
          line: 15,
          in_reply_to: 3,
          created_at: "2026-11-02T08:00:00Z",
        }),
      ],
      [commit],
    );
    expect(list.map((a) => a.message)).toEqual([
      "merged into main",
      "replied on src/pay/charge.ts:15",
      "commented",
      "add backoff",
      "opened this pull request",
    ]);
    expect(list.map((a) => a.kind)).toEqual(["event", "comment", "comment", "commit", "event"]);
    expect(list[0].author).toBe("lee");
    expect(list[3].sha).toBe("abc1234");
    // A comment's words come along; an empty one isn't listed at all.
    expect(list[2].body).toBe("Looks good");
  });

  test("a PR closed without merging says so", () => {
    expect(prActivity(PR({ state: "CLOSED" }), [], [])[0].message).toBe("Closed without merging");
  });
});

describe("a stack from its base up", () => {
  test("roots first, then what was stacked on them", () => {
    const n = (number: number, parent: number | null, children: number[]) => ({ number, parent, children });
    expect(stackOrder([n(3, 2, []), n(1, null, [2]), n(2, 1, [3])]).map((x) => x.number)).toEqual([1, 2, 3]);
    // A node whose parent isn't in the answer starts its own chain.
    expect(stackOrder([n(5, 99, []), n(6, 5, [])]).map((x) => x.number)).toEqual([5, 6]);
  });
});

describe("the comments sent to the agent", () => {
  test("every comment, who wrote it and where", () => {
    const { text } = gitChatFor({
      action: "add-comments",
      pr: { number: 412, title: "Retry" },
      comments: [
        COMMENT({ author: "sam", body: " Rename this \n" }),
        COMMENT({ author: "lee", body: "Off by one", path: "a.ts", line: 15 }),
      ],
    });
    expect(text).toBe(
      'Review comments on PR #412 "Retry". Please read them and address each one:\n\n' +
        "- @sam: Rename this\n- @lee (a.ts:15): Off by one",
    );
  });
});
