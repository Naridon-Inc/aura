import { describe, expect, it } from "bun:test";

import type { CloudRunner, Waking } from "../../lib/api";
import { machineCloudState } from "./machineState";

const runner = (online: boolean): CloudRunner => ({
  id: "r1",
  name: "build-box",
  agent_kinds: [],
  version: null,
  status: online ? "idle" : "offline",
  last_heartbeat_at: null,
  current_task: null,
  online,
});
const waking = (state: Waking["state"]): Waking => ({
  place: "build-box",
  machine_id: "ubuntu@203.0.113.42",
  state,
  since: state === "waking" ? 1 : 0,
  usually: 60,
  wakes_on_demand: true,
  note: "",
});
const up = { asleep: false, waking: null, runner: runner(true), unreachable: false };

describe("machineCloudState", () => {
  it("is running when nothing says otherwise, runner or not", () => {
    expect(machineCloudState(up)).toBe("running");
    expect(machineCloudState({ ...up, runner: null })).toBe("running");
  });
  it("is stopped while Aura holds it asleep", () => {
    expect(machineCloudState({ ...up, asleep: true, waking: waking("asleep") })).toBe("sleeping");
  });
  it("is starting while a wake is in flight, even over the sleeping row", () => {
    expect(machineCloudState({ ...up, asleep: true, waking: waking("waking") })).toBe("starting");
  });
  it("is unresponsive when the board stopped hearing from it", () => {
    expect(machineCloudState({ ...up, runner: runner(false), unreachable: true })).toBe(
      "unresponsive",
    );
  });
  it("is reconnecting when the board hears it but this window can't read it", () => {
    expect(machineCloudState({ ...up, unreachable: true })).toBe("reconnecting");
  });
});
