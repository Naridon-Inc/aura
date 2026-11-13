// The editor's presence pips share one radar poll per repo, every POLL_MS.
// The hook used to hand React a fresh subscribe function on each render, so
// each answer re-rendered, resubscribed, restarted the poll and asked again:
// the radar (one `aura radar show` process per read) was read back to back.

import { describe, expect, it } from "bun:test";

import { samePresence, type FilePresence } from "../src/lib/radarPresenceStore";
import { readSrc, stripComments } from "./support/code";

const entry = (over: Partial<FilePresence> = {}): FilePresence => ({
  actor: "priya",
  isAgent: false,
  kind: "editing",
  file: "src/pay/charge.ts",
  symbol: "chargeCard",
  ts: 1_700_000_000_000,
  color: "#4dc1a4",
  ...over,
});

describe("a quiet radar leaves the snapshot alone", () => {
  it("two empty reads are the same answer", () => {
    expect(samePresence([], [])).toBe(true);
  });

  it("the same people on the same files are the same answer", () => {
    expect(samePresence([entry()], [entry()])).toBe(true);
  });

  it("a newer event, a different file or one more person is news", () => {
    expect(samePresence([entry()], [entry({ ts: 1_700_000_000_500 })])).toBe(false);
    expect(samePresence([entry()], [entry({ file: "src/pay/retry.ts" })])).toBe(false);
    expect(samePresence([entry()], [entry(), entry({ actor: "sam" })])).toBe(false);
  });
});

describe("the hook subscribes once per repo", () => {
  it("holds its subscribe and snapshot callbacks instead of passing new ones", async () => {
    const src = stripComments(await readSrc("lib/radarPresenceStore.ts"));
    const call = src.match(/useSyncExternalStore\(([^)]*)\)/);
    expect(call).not.toBeNull();
    // Named, memoised callbacks — never an arrow written into the call.
    expect(call![1]).not.toContain("=>");
    expect(src).toMatch(/const subscribeRoot = useCallback\(/);
    expect(src).toMatch(/const snapshot = useCallback\(/);
  });

  it("only tells subscribers when the answer changed", async () => {
    const src = stripComments(await readSrc("lib/radarPresenceStore.ts"));
    const refresh = src.slice(src.indexOf("async function refresh("), src.indexOf("function startPolling("));
    expect(refresh).toContain("if (samePresence(s.entries, next)) return;");
  });
});
