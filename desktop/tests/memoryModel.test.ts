// The Memory surface's wording and its reading of the CLI's JSON replies.
//
//   bun test tests/memoryModel.test.ts

import { describe, expect, test } from "bun:test";
import {
  confidenceLabel,
  fmtDate,
  fmtTs,
  importSummary,
  isWritableSection,
  parseSearchHits,
  parseTags,
  parseWhy,
  scopeTooltip,
  sectionRank,
  shareNotice,
  shareTitle,
  shortSymbol,
  writeNotice,
} from "../src/components/dialogs/memory/memoryModel";

describe("parseSearchHits", () => {
  test("reads content, then description, then title, and drops empty hits", () => {
    const hits = parseSearchHits(
      JSON.stringify([
        { section: "gotchas", id: "a", content: "Retry caps at 60s", score: 0.9 },
        { section: "decisions", id: "b", description: "Chose Postgres" },
        { id: "c", title: "Identity line" },
        { id: "d" },
        null,
      ]),
    );
    expect(hits).toEqual([
      { section: "gotchas", id: "a", content: "Retry caps at 60s", score: 0.9 },
      { section: "decisions", id: "b", content: "Chose Postgres", score: undefined },
      { section: "", id: "c", content: "Identity line", score: undefined },
    ]);
  });

  test("anything that isn't a JSON array is no hits, not an error", () => {
    expect(parseSearchHits("not json")).toEqual([]);
    expect(parseSearchHits(JSON.stringify({ hits: [] }))).toEqual([]);
  });
});

describe("parseWhy", () => {
  test("a boolean verdict comes through with its reason and shared date", () => {
    expect(
      parseWhy(
        JSON.stringify({
          stale: true,
          stale_reason: "verify_token changed",
          supersedes_shared_at: "2026-10-01T00:00:00Z",
        }),
      ),
    ).toEqual({
      stale: true,
      reason: "verify_token changed",
      supersedesSharedAt: "2026-10-01T00:00:00Z",
    });
  });

  test("an unverifiable or unreadable reply is no verdict", () => {
    expect(parseWhy(JSON.stringify({ stale: null }))).toBeNull();
    expect(parseWhy("oops")).toBeNull();
  });
});

describe("what a write did", () => {
  test("reconcile outcomes are each said, and a plain add says nothing", () => {
    expect(writeNotice("noop")).toContain("already knew");
    expect(writeNotice("updated")).toContain("refined");
    expect(writeNotice("deleted")).toContain("retired");
    expect(writeNotice("added")).toBeNull();
  });

  test("a share only claims a signature the server reported", () => {
    expect(shareNotice(JSON.stringify({ signature: "signed", created: true }))).toBe(
      "Shared with your team — signed, so they can verify it came from you.",
    );
    expect(shareNotice(JSON.stringify({ signature: "unsigned", created: false }))).toBe(
      "Updated for your team. Your team can read it, but not verify who wrote it (unsigned).",
    );
    expect(shareNotice("garbage")).toBe(
      "Shared with your team. Your team can read it, but not verify who wrote it.",
    );
  });

  test("a long fact goes out under a trimmed title", () => {
    expect(shareTitle("short")).toBe("short");
    expect(shareTitle("x".repeat(100))).toBe(`${"x".repeat(72)}…`);
  });
});

describe("importSummary", () => {
  const base = { imported: 0, updated: 0, deduped: 0, total: 0 } as const;

  test("nothing remembered, an empty memory, and new facts each read differently", () => {
    expect(importSummary({ ...base, found: false } as never)).toContain("hasn't remembered");
    expect(importSummary({ ...base } as never)).toContain("was empty");
    expect(importSummary({ ...base, total: 5, imported: 2, updated: 1, deduped: 2 } as never)).toBe(
      "Brought in 3 facts Claude Code remembered about this repository. 2 were already here.",
    );
    expect(importSummary({ ...base, total: 1, deduped: 1 } as never)).toBe("1 was already here.");
  });
});

describe("labels", () => {
  test("only Aura's own sections are off limits to a hand-written fact", () => {
    expect(isWritableSection("gotchas")).toBe(true);
    expect(isWritableSection("decisions")).toBe(false);
    expect(isWritableSection("architecture")).toBe(false);
  });

  test("known sections sort in the friendly order, unknown ones last", () => {
    expect(sectionRank("decisions")).toBeLessThan(sectionRank("context"));
    expect(sectionRank("mystery")).toBe(99);
  });

  test("tags are split on commas and trimmed", () => {
    expect(parseTags(" auth, perf ,, p0 ")).toEqual(["auth", "perf", "p0"]);
  });

  test("confidence stays quiet at the engine's baseline", () => {
    expect(confidenceLabel(0.9)).toBe("High confidence");
    expect(confidenceLabel(0.5)).toBe("Medium confidence");
    expect(confidenceLabel(0.3)).toBeNull();
    expect(confidenceLabel(undefined)).toBeNull();
  });

  test("a scope manifest is narrated from the fields it has", () => {
    expect(scopeTooltip(undefined)).toBeNull();
    expect(scopeTooltip({})).toBe("Recorded with a scope manifest.");
    expect(scopeTooltip({ agent: "claude", session_id: "abcdefghijklmnop" })).toBe(
      "Recorded by claude, during session abcdefghijkl — this fact is bound to where it was written.",
    );
    expect(scopeTooltip({ checkout_id: "c1" })).toBe(
      "Recorded in checkout c1 — this fact is bound to where it was written.",
    );
  });

  test("an anchor keeps its file name and symbol", () => {
    expect(shortSymbol("src/auth/token.rs#verify_token")).toBe("token.rs#verify_token");
    expect(shortSymbol("README.md")).toBe("README.md");
  });

  test("an unreadable date is blank, never Invalid Date", () => {
    expect(fmtDate("nope")).toBe("");
    expect(fmtDate(undefined)).toBe("");
  });

  test("recent times read as minutes and hours ago", () => {
    const now = 1_800_000_000_000;
    expect(fmtTs(now / 1000 - 10, now)).toBe("just now");
    expect(fmtTs(now / 1000 - 5 * 60, now)).toBe("5m ago");
    expect(fmtTs(now / 1000 - 3 * 3600, now)).toBe("3h ago");
    expect(fmtTs(0, now)).toBe("");
  });
});
