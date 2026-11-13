import { afterEach, describe, expect, test } from "bun:test";

import { clearMachines, syncMachines } from "./activeMachine";
import { leaveCloud, openCloud } from "./cloudPlace";
import {
  CLOUD_SCOPE,
  LOCAL_SCOPE,
  belongsToScope,
  filterToScope,
  placeScopeKey,
  placeScopeNow,
  placeScopeOf,
  sameScope,
  type PlaceScope,
  type WorkspaceHome,
} from "./placeScope";

const BOX = "ubuntu@runner";
const ON_BOX: PlaceScope = { kind: "machine", machineId: BOX };

afterEach(() => {
  clearMachines();
  leaveCloud();
});

describe("placeScopeOf", () => {
  test("this computer when nothing else is in front", () => {
    expect(placeScopeOf({ cloudOpen: false, machineId: null })).toEqual(LOCAL_SCOPE);
  });

  test("the machine in front", () => {
    expect(placeScopeOf({ cloudOpen: false, machineId: BOX })).toEqual(ON_BOX);
  });

  test("the cloud covers a machine held behind it", () => {
    expect(placeScopeOf({ cloudOpen: true, machineId: BOX })).toEqual(CLOUD_SCOPE);
  });
});

describe("placeScopeNow", () => {
  test("reads the focused machine", () => {
    syncMachines([{ key: "a", machineId: BOX }], "a");
    expect(placeScopeNow()).toEqual(ON_BOX);
  });

  test("a machine held but not in front is not where you are", () => {
    syncMachines([{ key: "a", machineId: BOX }], null);
    expect(placeScopeNow()).toEqual(LOCAL_SCOPE);
  });

  test("the open cloud", () => {
    openCloud("home");
    expect(placeScopeNow()).toEqual(CLOUD_SCOPE);
  });
});

describe("belongsToScope", () => {
  const local: WorkspaceHome = {};
  const cloud: WorkspaceHome = { cloud: true };
  const box: WorkspaceHome = { machineId: BOX };
  const other: WorkspaceHome = { machineId: "me@other" };

  test("this computer lists only its own checkouts and copies", () => {
    expect([local, cloud, box, other].map((h) => belongsToScope(LOCAL_SCOPE, h))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  test("the cloud lists only cloud workspaces", () => {
    expect([local, cloud, box, other].map((h) => belongsToScope(CLOUD_SCOPE, h))).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  test("a machine lists only its own workspaces", () => {
    expect([local, cloud, box, other].map((h) => belongsToScope(ON_BOX, h))).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  test("a null machine is this computer", () => {
    expect(belongsToScope(LOCAL_SCOPE, { machineId: null })).toBe(true);
  });
});

test("filterToScope keeps order", () => {
  const rows = [
    { id: 1, machineId: BOX },
    { id: 2 },
    { id: 3, machineId: BOX },
  ];
  expect(filterToScope(ON_BOX, rows, (r) => r).map((r) => r.id)).toEqual([1, 3]);
});

test("keys and equality", () => {
  expect(placeScopeKey(LOCAL_SCOPE)).toBe("local");
  expect(placeScopeKey(CLOUD_SCOPE)).toBe("cloud");
  expect(placeScopeKey(ON_BOX)).toBe(`machine:${BOX}`);
  expect(sameScope(ON_BOX, { kind: "machine", machineId: BOX })).toBe(true);
  expect(sameScope(ON_BOX, LOCAL_SCOPE)).toBe(false);
});
