import { describe, expect, test } from "bun:test";

import { decideSwitch, rootIsWorking, type SwitchRequest } from "./branchSwitchGuard";

function request(log: string[]): SwitchRequest {
  return { branchName: "feature/login", switchBranch: () => log.push("switched") };
}

describe("rootIsWorking", () => {
  const roots = new Set(["/repo", "/repo-feature"]);

  test("an agent in this checkout counts", () => {
    expect(rootIsWorking(roots, "/repo")).toBe(true);
    expect(rootIsWorking(roots, "/repo/")).toBe(true);
  });

  test("an agent in another checkout does not", () => {
    expect(rootIsWorking(roots, "/other")).toBe(false);
    expect(rootIsWorking(new Set(["/repo-feature"]), "/repo")).toBe(false);
  });
});

describe("decideSwitch", () => {
  test("nothing running switches straight away", () => {
    const log: string[] = [];
    const held: SwitchRequest[] = [];
    expect(decideSwitch(false, request(log), (r) => held.push(r))).toBe("switching");
    expect(log).toEqual(["switched"]);
    expect(held).toHaveLength(0);
  });

  test("a running agent holds the switch for a yes", () => {
    const log: string[] = [];
    const held: SwitchRequest[] = [];
    expect(decideSwitch(true, request(log), (r) => held.push(r))).toBe("confirming");
    expect(log).toEqual([]);
    expect(held.map((r) => r.branchName)).toEqual(["feature/login"]);
    held[0].switchBranch();
    expect(log).toEqual(["switched"]);
  });
});
