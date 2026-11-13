import { describe, expect, test } from "bun:test";

import {
  costLabel,
  defaultSyncFolder,
  payerOf,
  readSyncPrefs,
  resourcesOf,
  sizeGb,
  starterClaude,
  workspaceInfo,
  writeSyncPrefs,
} from "./cloudWorkspaceMachine";

const memStore = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

describe("the machine rows", () => {
  test("sizes read as whole gigabytes once there are ten", () => {
    expect(sizeGb(16 * 1024 * 1024)).toBe(16);
    expect(sizeGb(64.4 * 1024 * 1024)).toBe(64);
    expect(sizeGb(1.5 * 1024 * 1024)).toBe(1.5);
  });

  test("a box's answer becomes the CPU, Memory and Disk rows", () => {
    expect(
      resourcesOf({
        cores: 8,
        cpu_used: 0.2,
        memory_kb: 16 * 1024 * 1024,
        memory_used: 9.6,
        disk_kb: 64 * 1024 * 1024,
        disk_used: 41.1,
      }),
    ).toEqual({ cpu: 8, memory: 16, disk: 64, usage: { cpu: 0.2, memory: 9.6, disk: 41.1 } });
  });
});

describe("agent cost", () => {
  test("a priced chat shows what it billed", () => {
    expect(costLabel({ sessionUsd: 0.12, sessionEstimated: false, sessionPartial: false }, "x")).toBe("12¢");
    expect(costLabel({ sessionUsd: 3.456, sessionEstimated: false, sessionPartial: false }, "x")).toBe("$3.46");
    expect(costLabel({ sessionUsd: 0.5, sessionEstimated: false, sessionPartial: true }, "x")).toBe("≥ 50¢");
    expect(costLabel({ sessionUsd: 0.5, sessionEstimated: true, sessionPartial: false }, "x")).toBe("~50¢");
  });

  test("a chat nobody priced says whose sign-in it runs on, never a zero", () => {
    const payer = payerOf({ drives: false, boxDriven: true, driver: null, mine: false, starter: "Mo" });
    expect(costLabel(null, payer)).toBe("Not metered · runs on Mo’s Claude");
    expect(payerOf({ drives: true, boxDriven: false, driver: "Sam", mine: false, starter: null })).toBe("your own sign-in");
    expect(payerOf({ drives: false, boxDriven: false, driver: "Sam", mine: false, starter: "Mo" })).toBe("Sam’s own sign-in");
  });

  test("a computer-run workspace runs on its starter’s Claude, whoever sends", () => {
    expect(payerOf({ drives: false, boxDriven: true, driver: null, mine: true, starter: "Mo" })).toBe("your Claude");
    expect(starterClaude({ mine: false, starter: "Mo" })).toBe("Mo’s Claude");
    expect(starterClaude({ mine: false, starter: null })).toBe("the Claude of whoever started it");
  });
});

describe("sync to a local directory", () => {
  test("each workspace gets its own folder under home", () => {
    expect(defaultSyncFolder("/Users/me/", "app", "feat/login", "w1")).toBe("/Users/me/Aura/Cloud/app-feat-login");
    expect(defaultSyncFolder("/Users/me", "app", null, "w1")).toBe("/Users/me/Aura/Cloud/app-w1");
  });

  test("the switch and folder are remembered per workspace", () => {
    const store = memStore();
    expect(readSyncPrefs(store, "w1")).toEqual({ on: false, folder: null });
    writeSyncPrefs(store, "w1", { on: true, folder: "/Users/me/x" });
    expect(readSyncPrefs(store, "w1")).toEqual({ on: true, folder: "/Users/me/x" });
    expect(readSyncPrefs(store, "w2")).toEqual({ on: false, folder: null });
    store.setItem("aura.cloudWorkspace.sync.w3", "{not json");
    expect(readSyncPrefs(store, "w3")).toEqual({ on: false, folder: null });
  });
});

test("workspace info names the machine only when there is one", () => {
  const base = {
    title: "Fix login",
    id: "w1",
    repository: "app",
    branch: "fix/login",
    state: "Running",
    createdBy: "You",
    createdAt: "2h ago",
    link: null,
    place: null,
  };
  expect(workspaceInfo(base)).not.toContain("Machine:");
  const onBox = workspaceInfo({
    ...base,
    link: "https://example.test/w/w1",
    place: { machine: "runner", remote_root: "/srv/app-fix", branch: "fix/login", engine: "claude", agent_session_id: null },
  });
  expect(onBox).toContain("Machine: runner");
  expect(onBox).toContain("Folder: /srv/app-fix");
  expect(onBox).toContain("Link: https://example.test/w/w1");
});
