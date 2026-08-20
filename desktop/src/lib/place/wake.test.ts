import { describe, expect, test } from "bun:test";

import type { Waking } from "../api";
import {
  isWaking,
  runningLate,
  startsItselfLine,
  startsWhenUsed,
  usuallyTakes,
  waitedFor,
  wakeBadge,
  wakeHeadline,
  wakeProgress,
  wakingFor,
} from "./wake";

const NOON = 1_750_010_000; // unix seconds; the clock is handed in
const at = (secs: number) => (NOON + secs) * 1000;

/** A managed place, in whichever of the three states the test is about. */
function place(over: Partial<Waking> = {}): Waking {
  return {
    place: "crew-box",
    machine_id: "mo@10.1.2.3:/srv/alpha",
    state: "awake",
    since: 0,
    usually: 60,
    wakes_on_demand: true,
    note: "",
    ...over,
  };
}

const starting = (over: Partial<Waking> = {}) =>
  place({ state: "waking", since: NOON, ...over });

/** Every word that would send somebody to a support channel about a machine
 *  that is working exactly as designed. */
const ALARMING = [
  "unreachable",
  "offline",
  "failed",
  "error",
  "broken",
  "down",
  "timed out",
  "refused",
];

describe("knowing a wake is in the air", () => {
  test("an awake place has no wait to draw", () => {
    const up = place();
    expect(isWaking(up)).toBe(false);
    expect(wakingFor(up, at(30))).toBe(0);
    expect(waitedFor(up, at(30))).toBe("");
    expect(wakeBadge(up)).toBe("");
    expect(wakeHeadline(up, at(30))).toBe("");
  });

  test("a place that is starting counts from when it started", () => {
    const w = starting();
    expect(isWaking(w)).toBe(true);
    expect(wakingFor(w, at(18))).toBe(18);
    expect(waitedFor(w, at(18))).toBe("18s");
    expect(wakeBadge(w)).toBe("Starting…");
  });

  test("a wake that reads as beginning in the future counts as just started", () => {
    // Two clocks — the machine book's and the browser's — and no promise they
    // agree to the second. A negative elapsed would render as "-3s" under a
    // spinner, which reads as a bug in Aura rather than as a clock skew nobody
    // needs to know about.
    const w = starting();
    expect(wakingFor(w, at(-3))).toBe(0);
    expect(waitedFor(w, at(-3))).toBe("just now");
  });

  test("seconds while they are worth counting, then minutes", () => {
    expect(waitedFor(starting(), at(45))).toBe("45s");
    expect(waitedFor(starting(), at(120))).toBe("2m");
  });
});

describe("the shape of the wait", () => {
  test("the bar fills across the usual wait", () => {
    const w = starting();
    expect(wakeProgress(w, at(0))).toBe(0);
    expect(wakeProgress(w, at(30))).toBe(0.5);
    expect(wakeProgress(w, at(60))).toBe(1);
  });

  test("the bar stops at full rather than claiming more than all of it", () => {
    // A progress bar past 100% is a bar that has admitted its estimate was
    // wrong while still pretending to measure. Past the usual wait the bar sits
    // full and the WORDS change instead.
    expect(wakeProgress(starting(), at(300))).toBe(1);
  });

  test("the usual wait comes from the engine, not from here", () => {
    // The number the sweep actually waits and the number a member is promised
    // are the same number, or the feature teaches people that Aura's estimates
    // mean nothing.
    expect(usuallyTakes(place({ usually: 60 }))).toBe("about a minute");
    expect(usuallyTakes(place({ usually: 180 }))).toBe("about 3 minutes");
  });

  test("a place with no stated wait still says something sensible", () => {
    // An older engine, or a field that arrived as 0. Dividing by it would
    // produce a bar of NaN, and NaN renders as an empty bar that never moves —
    // the exact appearance of a hang.
    const w = starting({ usually: 0 });
    expect(usuallyTakes(w)).toBe("about a minute");
    expect(wakeProgress(w, at(30))).toBe(0.5);
    expect(Number.isFinite(wakeProgress(w, at(30)))).toBe(true);
  });
});

describe("saying it out loud", () => {
  test("the line names the machine, the wait, and what survived", () => {
    const said = wakeHeadline(starting(), at(10));
    expect(said).toContain("Starting crew-box");
    expect(said).toContain("about a minute");
    expect(said).toContain("still there");
  });

  test("past the usual wait it says so, and still is not an error", () => {
    // The moment the feature is most likely to be misread. A cloud having a
    // slow afternoon is not a fault, and a surface that turns red at sixty-one
    // seconds has taught the member to distrust something that works.
    const w = starting();
    expect(runningLate(w, at(45))).toBe(false);
    expect(runningLate(w, at(75))).toBe(true);
    const said = wakeHeadline(w, at(75));
    expect(said).toContain("Still starting");
    expect(said).toContain("75s so far");
    expect(said).toContain("Nothing is wrong");
  });

  test("no sentence about a starting machine describes it as broken", () => {
    // The rule `sleep.ts` keeps, carried through the minute that follows it. It
    // is one word in one branch, and it is the difference between a member
    // waiting and a member filing a ticket.
    const w = starting();
    const everything = [
      wakeHeadline(w, at(5)),
      wakeHeadline(w, at(400)),
      wakeBadge(w),
      startsItselfLine(place({ state: "asleep" })),
    ].join(" ");
    for (const word of ALARMING) {
      expect(everything.toLowerCase()).not.toContain(word);
    }
  });

  test("an asleep place says that using it is enough", () => {
    const said = startsItselfLine(place({ state: "asleep" }));
    expect(said).toContain("isn't costing anything");
    expect(said).toContain("Using it starts it");
    expect(said).toContain("about a minute");
  });

  test("a box you brought is not promised a wake it will not get", () => {
    // Aura holds no account that could switch on somebody else's hardware. The
    // engine's own `note` says who has to; the worst thing this file could do
    // is talk over it with a promise that reaching the box wakes it.
    const byoc = place({ state: "asleep", wakes_on_demand: false });
    expect(startsWhenUsed(byoc)).toBe(false);
    expect(startsItselfLine(byoc)).toBe("");
    expect(wakeBadge(byoc)).toBe("Asleep");
  });

  test("no sentence here leaks how the machine is made", () => {
    // The words a member reads are about their machine, not about the
    // substrate underneath it — the same rule the engine side keeps.
    const said = [
      wakeHeadline(starting(), at(5)),
      wakeHeadline(starting(), at(400)),
      startsItselfLine(place({ state: "asleep" })),
    ].join(" ");
    for (const jargon of ["instance", "EC2", "provision", "substrate", "SSH"]) {
      expect(said).not.toContain(jargon);
    }
  });
});
