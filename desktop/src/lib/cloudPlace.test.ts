// Run with: bun test src/lib/cloudPlace.test.ts
//
// Where a Team row takes you, and this laptop's terminal dock, which never
// shows under the cloud place's pages and keeps its open/closed choice.

import { describe, expect, test } from "bun:test";
import {
  cloudCoversWork,
  cloudPlaceNow,
  localTerminalShown,
  openCloud,
  setCloudOwners,
  setCloudPage,
  workOf,
  type CloudPlaceState,
} from "./cloudPlace";

// A Team row opens Home narrowed to that teammate, and stays selected only
// while Home shows just them. There is no teammate page to go to.
describe("a Team row narrows Home", () => {
  test("clicking a teammate shows Home with only their workspaces", () => {
    openCloud("home", ["u-ana"]);
    const now = cloudPlaceNow();
    expect(now.page).toBe("home");
    expect(now.owners).toEqual(["u-ana"]);
    expect(workOf(now)).toBe("u-ana");
  });

  test("the row lets go when Home widens, or another page opens", () => {
    openCloud("home", ["u-ana"]);
    setCloudOwners(["u-ana", "u-bo"]);
    expect(workOf(cloudPlaceNow())).toBeNull();

    openCloud("home", ["u-ana"]);
    setCloudPage("dashboard");
    expect(workOf(cloudPlaceNow())).toBeNull();

    openCloud("home", ["u-ana"]);
    openCloud("home");
    expect(workOf(cloudPlaceNow())).toBeNull();
  });
});

function place(over: Partial<CloudPlaceState> = {}): CloudPlaceState {
  return {
    open: false,
    page: "home",
    owners: [],
    workspaceId: null,
    creating: false,
    notice: "",
    defaultRepo: null,
    ...over,
  };
}

describe("localTerminalShown", () => {
  test("on this laptop the dock follows the user's open/closed choice", () => {
    expect(localTerminalShown(true, place())).toBe(true);
    expect(localTerminalShown(false, place())).toBe(false);
  });

  test("no cloud page shows it, whatever the choice", () => {
    for (const page of ["home", "dashboard", "routines", "onboarding"] as const) {
      expect(localTerminalShown(true, place({ open: true, page }))).toBe(false);
    }
  });

  test("a cloud job read in the work area is still the cloud: no local dock", () => {
    const thread = place({ open: true, page: "workspace", workspaceId: "cloud:job-1" });
    // The work area is the thread's, not the cloud page's…
    expect(cloudCoversWork(thread)).toBe(false);
    // …but the machine behind it is not this laptop.
    expect(localTerminalShown(true, thread)).toBe(false);
  });

  test("leaving the cloud brings the dock back as it was", () => {
    const open = true;
    expect(localTerminalShown(open, place({ open: true }))).toBe(false);
    expect(localTerminalShown(open, place({ open: false }))).toBe(true);
  });
});
