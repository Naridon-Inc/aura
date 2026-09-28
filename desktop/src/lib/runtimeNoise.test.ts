import { describe, expect, test } from "bun:test";

import { isEditorWorkerFailure, isIgnorableThrow } from "./runtimeNoise";

function withStack(message: string, stack: string): Error {
  const e = new Error(message);
  e.stack = stack;
  return e;
}

// The shape WebKit reported for a hover on a tab whose path kept a "../".
const HOVER_FAILURE = withStack(
  "Could not find source file: 'file:///repo/../x/closure.ts'.",
  [
    "N@tauri://localhost/assets/ts.worker-BH9nVgjN.js:414:6550",
    "getQuickInfoAtPosition@tauri://localhost/assets/ts.worker-BH9nVgjN.js:67718:3448",
    "_handleMessage@tauri://localhost/assets/ts.worker-BH9nVgjN.js:7:36783",
  ].join("\n"),
);

describe("isEditorWorkerFailure", () => {
  test("a hover the TypeScript worker could not answer is an editor failure", () => {
    expect(isEditorWorkerFailure(HOVER_FAILURE)).toBe(true);
  });

  test("the dev server's worker bundle name counts too", () => {
    const dev = withStack(
      "boom",
      "f@http://localhost:1420/node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js?worker_file&type=module:1:1",
    );
    expect(isEditorWorkerFailure(dev)).toBe(true);
  });

  test("an app error is not one", () => {
    const app = withStack("x is undefined", "render@tauri://localhost/assets/index-_hahgz2R.js:250:21");
    expect(isEditorWorkerFailure(app)).toBe(false);
    expect(isEditorWorkerFailure("ts.worker")).toBe(false);
    expect(isEditorWorkerFailure(null)).toBe(false);
  });

  test("it still reaches telemetry: it is a failure, not teardown noise", () => {
    expect(isIgnorableThrow(HOVER_FAILURE)).toBe(false);
  });
});
