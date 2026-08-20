import { describe, expect, test } from "bun:test";

import type { Place } from "./contract";
import { placeHere, placeOfMachine } from "./contract";
import {
  asleepFor,
  isAsleep,
  isReachable,
  sleepBadge,
  sleepTooltip,
  sleepingInsteadOfError,
} from "./sleep";

/** A book row for a machine Aura made, awake unless the test says otherwise. */
function box(asleepSince = 0): Place {
  return placeOfMachine({
    id: "mo@10.1.2.3:/srv/alpha",
    name: "aura-managed",
    host: "10.1.2.3",
    user: "mo",
    key_path: "/Users/me/.ssh/aura-managed.pem",
    box_kind: "managed",
    repo_path: "/srv/alpha",
    project_root: "/Users/me/alpha",
    repo_branch: "main",
    org_slug: "naridon",
    added_at: 1_750_000_000,
    last_used_at: 1_750_003_600,
    asleep_since: asleepSince,
  });
}

const NOON = 1_750_010_000_000; // ms, because the clock is handed in

describe("telling asleep apart from broken", () => {
  test("a machine with no sleep stamp is awake and worth dialling", () => {
    const awake = box();
    expect(isAsleep(awake)).toBe(false);
    expect(isReachable(awake)).toBe(true);
    expect(sleepBadge(awake)).toBe("");
  });

  test("a book row written before the field existed is not asleep", () => {
    // The whole book predates `asleep_since`. Reading a missing field as a
    // timestamp would draw every machine anyone owns as stopped, which is the
    // failure this task exists to prevent, arriving through the back door.
    const old = placeOfMachine({
      id: "ubuntu@10.0.0.4:/srv/alpha",
      name: "aura-runner",
      host: "10.0.0.4",
      user: "ubuntu",
      key_path: "/Users/me/.ssh/aura-runner.pem",
      box_kind: "shared",
      repo_path: "/srv/alpha",
      project_root: "/Users/me/alpha",
      repo_branch: "main",
      org_slug: null,
      added_at: 1_750_000_000,
      last_used_at: 1_750_003_600,
    });
    expect(isAsleep(old)).toBe(false);
  });

  test("this laptop is never asleep", () => {
    // Aura does not switch off the computer you are looking at, so nothing that
    // draws the local place should ever have to handle a sleeping one.
    expect(isAsleep(placeHere("/Users/me/alpha"))).toBe(false);
    expect(isReachable(placeHere("/Users/me/alpha"))).toBe(true);
  });

  test("a stopped machine is asleep, not unreachable", () => {
    const stopped = box(1_750_009_000);
    expect(isAsleep(stopped)).toBe(true);
    expect(isReachable(stopped)).toBe(false);
    expect(sleepBadge(stopped)).toBe("Asleep");
  });

  test("the sentence shown instead of an error never says the machine is broken", () => {
    // The exact bug: a stopped box refuses connections the way a dead one does,
    // so a surface that prints its dial failure tells somebody their machine
    // died when Aura stopped it on purpose to save them money.
    const said = sleepingInsteadOfError(box(1_750_009_000));
    expect(said).not.toBeNull();
    for (const alarming of [
      "unreachable",
      "offline",
      "failed",
      "error",
      "couldn't reach",
      "broken",
      "down",
    ]) {
      expect(said!.toLowerCase()).not.toContain(alarming);
    }
    expect(said).toContain("asleep");
    // And the reassurance, without which "asleep" still reads as a machine
    // that has gone away with the work on it.
    expect(said!.toLowerCase()).toContain("disk");
  });

  test("an awake place gets no excuse, so a real failure is still a failure", () => {
    // The null is the contract: a caller keeps its own error path and only asks
    // whether THIS failure was expected. If this returned a sentence for an
    // awake box, a genuinely dead machine would read as merely sleeping and
    // nobody would go and look at it.
    expect(sleepingInsteadOfError(box())).toBeNull();
  });

  test("how long it has been asleep reads in the units a person thinks in", () => {
    const now = NOON;
    const at = Math.floor(now / 1000);
    expect(asleepFor(box(at - 20), now)).toBe("just now");
    expect(asleepFor(box(at - 5 * 60), now)).toBe("5m");
    expect(asleepFor(box(at - 90 * 60), now)).toBe("1h");
    expect(asleepFor(box(at - 50 * 3600), now)).toBe("2d");
  });

  test("a machine whose stamp is in the future says nothing rather than nonsense", () => {
    // Clocks disagree — the stamp is written by whichever machine ran the
    // sweep. A row that would print "asleep for -3 minutes" prints nothing,
    // because a wrong duration on a correct state is worse than no duration.
    expect(asleepFor(box(Math.floor(NOON / 1000) + 600), NOON)).toBe("");
  });

  test("an awake place has no duration and no tooltip to show", () => {
    expect(asleepFor(box(), NOON)).toBe("");
    expect(sleepTooltip(box(), NOON)).toBe("");
  });

  test("the tooltip says what happened, what it costs, and that nothing was lost", () => {
    const tip = sleepTooltip(box(Math.floor(NOON / 1000) - 7200), NOON);
    expect(tip).toContain("Asleep for 2h");
    expect(tip.toLowerCase()).toContain("isn't costing");
    expect(tip.toLowerCase()).toContain("still there");
  });

  test("nothing outside this file works out for itself whether a place is asleep", async () => {
    // The rule that keeps the three surfaces saying one thing. Each of them
    // draws a place from the same row, and each could read the stamp itself in
    // four characters — at which point the roster's idea of asleep, the rail's
    // and the panel's are three opinions that only have to agree until one of
    // them is edited. `contract.ts` is exempt because it is where the field
    // arrives, and this file because it is where the question is answered.
    const src = `${import.meta.dir}/../..`;
    const mine = new Set([
      "lib/place/sleep.ts",
      "lib/place/sleep.test.ts",
      "lib/place/contract.ts",
      "lib/api.ts",
    ]);
    const guilty: string[] = [];
    for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: src })) {
      if (mine.has(rel)) continue;
      const text = await Bun.file(`${src}/${rel}`).text();
      const reads = text.split("\n").filter((line) => {
        const t = line.trim();
        if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) {
          return false;
        }
        return t.includes("asleepSince") || t.includes("asleep_since");
      });
      // A fixture stating the field is fine — that is the row, not a decision
      // taken about it. Anything that COMPARES it is a second spelling.
      if (reads.some((l) => /asleep(Since|_since)\s*[><!=]/.test(l))) {
        guilty.push(rel);
      }
    }
    expect(
      guilty,
      "these files decide for themselves whether a place is asleep — use isAsleep",
    ).toEqual([]);
  });

  test("a place asleep this minute is not described as asleep for zero", () => {
    // "Asleep for just now" is not a sentence. The duration is dropped rather
    // than printed badly.
    const tip = sleepTooltip(box(Math.floor(NOON / 1000) - 10), NOON);
    expect(tip).toStartWith("Asleep —");
  });
});
