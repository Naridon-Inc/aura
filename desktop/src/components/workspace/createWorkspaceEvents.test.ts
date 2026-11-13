// What this pins: a request to open the Create workspace dialog carries the
// repository and the start it was asked with, and nothing it wasn't — a
// pull request's "Open as workspace" lands on that pull request, a plain
// request names no start, so the dialog's own default stays in charge.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CREATE_WORKSPACE_EVENT,
  openCreateWorkspace,
  type CreateWorkspaceRequest,
} from "./createWorkspaceEvents";

let seen: CreateWorkspaceRequest[] = [];
const realWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  seen = [];
  // bun's runner has no DOM; the module only dispatches on `window`.
  (globalThis as { window?: unknown }).window = {
    dispatchEvent: (e: Event) => {
      if (e.type === CREATE_WORKSPACE_EVENT) seen.push((e as CustomEvent<CreateWorkspaceRequest>).detail);
      return true;
    },
  };
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

describe("openCreateWorkspace", () => {
  test("a pull request's start rides on the request", () => {
    const from = { kind: "pr" as const, ref: "feat/stack-api", label: "#103 Stack API" };
    openCreateWorkspace("/r", { from });
    expect(seen).toEqual([{ repoRoot: "/r", from }]);
  });

  test("a plain request names no start", () => {
    openCreateWorkspace("/r");
    openCreateWorkspace(undefined, { createFrom: true });
    expect(seen).toEqual([{ repoRoot: "/r" }, { createFrom: true }]);
  });
});
