// One machine, every name it has gone by.
//
// A machine row is named by an id that says nothing about where the box is,
// and lists the ids it answered to before. Everything here is about an id
// somebody saved — in a workspace, a chat pointer, a tab strip — finding the
// row it meant after that row was renamed or reconnected somewhere new.

import { afterEach, describe, expect, test } from "bun:test";

import {
  answersTo,
  canonicalMachineId,
  carryForward,
  findMachine,
  forgetLearnedMachineIds,
  knownIdsOf,
  learnMachineIds,
  machineIdsOf,
  type PointerStore,
} from "./machineRef";

const OLD = "ubuntu@10.0.0.1:/srv/aura";
const NOW = "m-0123456789abcdef";
const row = { id: NOW, aliases: [OLD] };
const other = { id: "m-fedcba9876543210", aliases: [] };

function store(seed: Record<string, string> = {}) {
  const kept = new Map(Object.entries(seed));
  const s: PointerStore & { kept: Map<string, string> } = {
    kept,
    getItem: (k) => kept.get(k) ?? null,
    setItem: (k, v) => void kept.set(k, v),
    removeItem: (k) => void kept.delete(k),
  };
  return s;
}

afterEach(() => forgetLearnedMachineIds());

describe("finding the row an id names", () => {
  test("by the id it has now", () => {
    expect(findMachine([other, row], NOW)).toBe(row);
  });

  test("by an id it had before", () => {
    expect(findMachine([other, row], OLD)).toBe(row);
    expect(answersTo(row, OLD)).toBe(true);
    expect(answersTo(row, ` ${OLD} `)).toBe(true);
  });

  test("a row's own id wins over another row's old one", () => {
    // Somebody else's former name must never shadow a name handed out today.
    const shadow = { id: "m-1111111111111111", aliases: [NOW] };
    expect(findMachine([shadow, row], NOW)).toBe(row);
  });

  test("an id no row answers to finds nothing, and neither does no id", () => {
    expect(findMachine([row], "m-9999999999999999")).toBeNull();
    expect(findMachine([row], null)).toBeNull();
    expect(findMachine([row], "  ")).toBeNull();
    expect(findMachine(null, NOW)).toBeNull();
    expect(answersTo(row, null)).toBe(false);
  });

  test("a row's ids are its own first, then the ones before", () => {
    expect(machineIdsOf(row)).toEqual([NOW, OLD]);
    expect(machineIdsOf({ id: NOW })).toEqual([NOW]);
  });
});

describe("what a book read teaches the window", () => {
  test("before any read, an id is itself", () => {
    expect(canonicalMachineId(OLD)).toBe(OLD);
    expect(knownIdsOf(OLD)).toEqual([OLD]);
  });

  test("after one, an old id means the id it goes by now", () => {
    learnMachineIds([row, other]);
    expect(canonicalMachineId(OLD)).toBe(NOW);
    expect(canonicalMachineId(NOW)).toBe(NOW);
    expect(knownIdsOf(OLD)).toEqual([NOW, OLD]);
    expect(knownIdsOf(NOW)).toEqual([NOW, OLD]);
  });

  test("this laptop stays this laptop", () => {
    learnMachineIds([row]);
    expect(canonicalMachineId(null)).toBeNull();
    expect(canonicalMachineId("")).toBeNull();
  });

  test("a reply that is not a list teaches nothing and breaks nothing", () => {
    expect(() => learnMachineIds(undefined)).not.toThrow();
    expect(() => learnMachineIds(null)).not.toThrow();
    expect(canonicalMachineId(OLD)).toBe(OLD);
  });
});

describe("a pointer filed under an old id", () => {
  const key = (id: string) => `aura.machineChat.${id}`;

  test("is found, and moved to the id the machine goes by now", () => {
    const s = store({ [key(OLD)]: "sess-1" });
    expect(carryForward(s, key, [NOW, OLD])).toBe("sess-1");
    expect(s.kept.get(key(NOW))).toBe("sess-1");
    expect(s.kept.has(key(OLD))).toBe(false);
  });

  test("one under the current id wins, and the old one is left alone", () => {
    const s = store({ [key(NOW)]: "sess-now", [key(OLD)]: "sess-old" });
    expect(carryForward(s, key, [NOW, OLD])).toBe("sess-now");
    expect(s.kept.get(key(OLD))).toBe("sess-old");
  });

  test("nothing filed anywhere is nothing", () => {
    expect(carryForward(store(), key, [NOW, OLD])).toBeNull();
    expect(carryForward(store(), key, [])).toBeNull();
  });

  test("a store that refuses the move still answers this read", () => {
    const s = store({ [key(OLD)]: "sess-1" });
    s.setItem = () => {
      throw new Error("quota");
    };
    expect(carryForward(s, key, [NOW, OLD])).toBe("sess-1");
  });
});
