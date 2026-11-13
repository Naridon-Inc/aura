import { describe, expect, test } from "bun:test";

import { agePeriodFor, createAgeClock, type ClockEnv } from "./useMinuteTick";

const S = 1_000;
const M = 60 * S;
const H = 60 * M;

describe("agePeriodFor", () => {
  test("a row seconds old is re-read every 15 s, so its seconds rung moves", () => {
    expect(agePeriodFor(0)).toBe(15 * S);
    expect(agePeriodFor(27 * S)).toBe(15 * S);
    expect(agePeriodFor(M - 1)).toBe(15 * S);
  });

  test("a row stamped a little ahead of this laptop's clock is treated as fresh", () => {
    expect(agePeriodFor(-5 * S)).toBe(15 * S);
  });

  test("minutes old is every 30 s, an hour or more is once a minute", () => {
    expect(agePeriodFor(M)).toBe(30 * S);
    expect(agePeriodFor(H - 1)).toBe(30 * S);
    expect(agePeriodFor(H)).toBe(M);
    expect(agePeriodFor(3 * 24 * H)).toBe(M);
  });

  test("an unknown age gets the slow pace", () => {
    expect(agePeriodFor(Number.NaN)).toBe(M);
    expect(agePeriodFor(Number.POSITIVE_INFINITY)).toBe(M);
  });
});

/** A clock driven by hand: `advance` moves time and fires the interval. */
function fakeEnv() {
  let now = 1_000_000;
  let hidden = false;
  const timers = new Map<number, { fn: () => void; ms: number; next: number }>();
  let ids = 0;
  const env: ClockEnv = {
    now: () => now,
    every: (fn, ms) => {
      const id = ++ids;
      timers.set(id, { fn, ms, next: now + ms });
      return id;
    },
    cancel: (h) => {
      timers.delete(h as number);
    },
    hidden: () => hidden,
  };
  return {
    env,
    timers,
    setHidden: (h: boolean) => {
      hidden = h;
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let due: { fn: () => void; ms: number; next: number } | null = null;
        for (const t of timers.values()) if (t.next <= end && (!due || t.next < due.next)) due = t;
        if (!due) break;
        now = due.next;
        due.next += due.ms;
        due.fn();
      }
      now = end;
    },
  };
}

describe("createAgeClock", () => {
  test("no listener, no interval; the last one leaving stops it", () => {
    const f = fakeEnv();
    const clock = createAgeClock(f.env);
    expect(clock.pace()).toBe(0);
    const off = clock.subscribe(M, () => {});
    expect(clock.pace()).toBe(M);
    expect(f.timers.size).toBe(1);
    off();
    expect(clock.pace()).toBe(0);
    expect(f.timers.size).toBe(0);
  });

  test("one interval at the fastest pace anyone asked for", () => {
    const f = fakeEnv();
    const clock = createAgeClock(f.env);
    const offSlow = clock.subscribe(M, () => {});
    const offFast = clock.subscribe(15 * S, () => {});
    expect(clock.pace()).toBe(15 * S);
    expect(f.timers.size).toBe(1);
    offFast();
    expect(clock.pace()).toBe(M);
    expect(f.timers.size).toBe(1);
    offSlow();
  });

  test("a slow listener is only re-rendered when its own period has passed", () => {
    const f = fakeEnv();
    const clock = createAgeClock(f.env);
    const fast: number[] = [];
    const slow: number[] = [];
    clock.subscribe(15 * S, (n) => fast.push(n));
    clock.subscribe(M, (n) => slow.push(n));
    f.advance(2 * M);
    expect(fast.length).toBe(8);
    expect(slow.length).toBe(2);
  });

  test("everyone due on a tick gets the same reading", () => {
    const f = fakeEnv();
    const clock = createAgeClock(f.env);
    const a: number[] = [];
    const b: number[] = [];
    clock.subscribe(15 * S, (n) => a.push(n));
    clock.subscribe(15 * S, (n) => b.push(n));
    f.advance(45 * S);
    expect(a).toEqual(b);
    expect(a.length).toBe(3);
  });

  test("the clock keeps moving: a listener sees later readings, not the first one", () => {
    const f = fakeEnv();
    const clock = createAgeClock(f.env);
    const seen: number[] = [];
    const start = f.env.now();
    clock.subscribe(30 * S, (n) => seen.push(n));
    f.advance(10 * M);
    expect(seen.length).toBe(20);
    expect(seen.at(-1)! - start).toBe(10 * M);
  });

  test("a hidden window renders nothing, and catches up the moment it shows", () => {
    const f = fakeEnv();
    const clock = createAgeClock(f.env);
    const seen: number[] = [];
    clock.subscribe(15 * S, (n) => seen.push(n));
    f.setHidden(true);
    f.advance(5 * M);
    expect(seen.length).toBe(0);
    f.setHidden(false);
    clock.wake();
    expect(seen).toEqual([f.env.now()]);
  });
});
