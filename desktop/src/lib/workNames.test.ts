import { describe, expect, test } from "bun:test";

import { PLACE_NAMES } from "./placeNames";
import {
  MAX_WORK_NAME_LENGTH,
  slugifyWorkName,
  stripWorkPrefixes,
  uniqueWorkName,
  workBranchName,
  workNameFrom,
} from "./workNames";

const NOTHING_TAKEN: ReadonlySet<string> = new Set<string>();

describe("slugifyWorkName", () => {
  test("kebabs a typed objective", () => {
    expect(slugifyWorkName("Fix the login bug!")).toBe("fix-the-login-bug");
    expect(slugifyWorkName("AURA-203")).toBe("aura-203");
    expect(slugifyWorkName("  --weird__name-- ")).toBe("weird-name");
  });

  test("empty input yields nothing rather than an invented name", () => {
    expect(slugifyWorkName("")).toBe("");
    expect(slugifyWorkName("   ")).toBe("");
    expect(workNameFrom("")).toBeNull();
    expect(workNameFrom(null)).toBeNull();
    expect(workNameFrom(undefined)).toBeNull();
  });

  test("unicode keeps only what actually survives", () => {
    // No transliteration — the name never claims letters nobody typed.
    expect(slugifyWorkName("★★★")).toBe("");
    expect(slugifyWorkName("日本語")).toBe("");
    expect(workNameFrom("日本語 — ★★★")).toBeNull();
    expect(slugifyWorkName("café-99")).toBe("caf-99");
    expect(slugifyWorkName("Añadir búsqueda")).toBe("a-adir-b-squeda");
  });

  test("an over-long objective is capped at a word boundary", () => {
    const slug = workNameFrom(
      "Switch the retry logic over to exponential backoff so we stop tripping the rate limit",
    );
    expect(slug).toBe("switch-the-retry-logic-over-to");
    expect(slug!.length).toBeLessThanOrEqual(MAX_WORK_NAME_LENGTH);
    expect(slug!.endsWith("-")).toBe(false);
  });

  test("an over-long single word is cut hard", () => {
    // No boundary to prefer — a hard cut beats a name too short to read.
    const slug = slugifyWorkName("a".repeat(80));
    expect(slug.length).toBe(MAX_WORK_NAME_LENGTH);
    expect(slug).toBe("a".repeat(MAX_WORK_NAME_LENGTH));
  });

  test("a boundary cut never shortens below the floor", () => {
    const slug = slugifyWorkName(`ab-${"z".repeat(60)}`);
    expect(slug.length).toBe(MAX_WORK_NAME_LENGTH);
    expect(slug.startsWith("ab-z")).toBe(true);
  });
});

describe("stripWorkPrefixes", () => {
  test("branch-flow prefixes come off", () => {
    expect(workNameFrom("feat/worktree-control-plane")).toBe("worktree-control-plane");
    expect(workNameFrom("fix/login")).toBe("login");
    expect(workNameFrom("FEAT/Login-Flow")).toBe("login-flow");
    expect(workNameFrom("refs/heads/feat/login")).toBe("login");
    expect(workNameFrom("origin/hotfix/rate-limit")).toBe("rate-limit");
    // Aura's own namespaces round-trip.
    expect(workNameFrom("work/auth-refactor")).toBe("auth-refactor");
  });

  test("a prefix that is the whole label survives as the name", () => {
    expect(workNameFrom("feat/")).toBe("feat");
    expect(workNameFrom("docs")).toBe("docs");
    expect(stripWorkPrefixes("work/")).toBe("work/");
  });

  test("a conventional-commit head comes off", () => {
    expect(workNameFrom("fix(auth): reject expired tokens")).toBe("reject-expired-tokens");
    expect(workNameFrom("feat: add retry backoff")).toBe("add-retry-backoff");
    // A colon that isn't a commit head is left alone.
    expect(workNameFrom("Bug: the sidebar jumps")).toBe("bug-the-sidebar-jumps");
  });
});

describe("uniqueWorkName", () => {
  test("the base is used when nothing is taken", () => {
    expect(uniqueWorkName("login-fix", NOTHING_TAKEN)).toBe("login-fix");
  });

  test("a collision is suffixed rather than colliding", () => {
    expect(uniqueWorkName("login-fix", new Set(["login-fix"]))).toBe("login-fix-2");
    expect(
      uniqueWorkName("login-fix", new Set(["login-fix", "login-fix-2", "login-fix-3"])),
    ).toBe("login-fix-4");
  });

  test("the suffix is made to fit inside the length cap", () => {
    const base = "a".repeat(MAX_WORK_NAME_LENGTH);
    const out = uniqueWorkName(base, new Set([base]));
    expect(out.length).toBeLessThanOrEqual(MAX_WORK_NAME_LENGTH);
    expect(out.endsWith("-2")).toBe(true);
  });
});

describe("workBranchName", () => {
  test("the branch is named after the objective the user typed", () => {
    expect(workBranchName("Fix the login bug", NOTHING_TAKEN)).toBe("fix-the-login-bug");
  });

  test("a second go at the same objective is suffixed, not collided", () => {
    const taken = new Set(["fix-the-login-bug"]);
    expect(workBranchName("Fix the login bug", taken)).toBe("fix-the-login-bug-2");
  });

  test("only an objective with nothing sluggable falls back to a place name", () => {
    for (const objective of ["", "   ", "★★★", "日本語"]) {
      const branch = workBranchName(objective, NOTHING_TAKEN);
      expect(PLACE_NAMES).toContain(branch);
    }
  });

  test("the place-name fallback still skips names already taken", () => {
    const free = PLACE_NAMES[PLACE_NAMES.length - 1];
    const taken = new Set(PLACE_NAMES.filter((n) => n !== free));
    expect(workBranchName("★★★", taken)).toBe(free);
  });
});
