// What these pin: how long a toast stays when the caller doesn't say, that
// replacing one by id keeps its place, which close reasons reach which
// callback, and that a toast still working can't be closed by default.

import { afterEach, describe, expect, it } from "bun:test";

import { DEFAULT_DURATION_MS, resolveDuration, toast, type Toast } from "./toast";

afterEach(() => toast.clear());

describe("resolveDuration", () => {
  it("closes a plain toast after five seconds", () => {
    expect(DEFAULT_DURATION_MS).toBe(5000);
    expect(resolveDuration({ title: "Saved" })).toBe(5000);
    expect(resolveDuration({ title: "Saved", tone: "danger" })).toBe(5000);
  });

  it("keeps a toast that is working or asks for a decision", () => {
    expect(resolveDuration({ tone: "loading" })).toBeNull();
    expect(resolveDuration({ actions: [{ label: "Undo", onClick: () => {} }] })).toBeNull();
    expect(resolveDuration({ actionRow: "row" })).toBeNull();
  });

  it("lets the caller decide, with 0 and Infinity meaning stay", () => {
    expect(resolveDuration({ durationMs: 11000 })).toBe(11000);
    expect(resolveDuration({ durationMs: null })).toBeNull();
    expect(resolveDuration({ durationMs: 0 })).toBeNull();
    expect(resolveDuration({ durationMs: Infinity })).toBeNull();
    // Explicit wins even over an action.
    expect(
      resolveDuration({ durationMs: 3000, actions: [{ label: "Open", onClick: () => {} }] }),
    ).toBe(3000);
  });
});

describe("the store", () => {
  it("replaces a toast by id in place, keeping its age", async () => {
    toast.info("First", undefined, { id: "a" });
    toast.info("Second", undefined, { id: "b" });
    const before = toast.get().find((t) => t.id === "a")!.createdAt;
    await new Promise((r) => setTimeout(r, 5));
    toast.success("First, updated", undefined, { id: "a" });
    const list = toast.get();
    expect(list.map((t) => t.id)).toEqual(["a", "b"]);
    expect(list[0].title).toBe("First, updated");
    expect(list[0].tone).toBe("success");
    expect(list[0].createdAt).toBe(before);
  });

  it("generates distinct ids when none is given", () => {
    const a = toast.info("One");
    const b = toast.info("Two");
    expect(a).not.toBe(b);
    expect(toast.get()).toHaveLength(2);
  });

  it("makes a working toast unclosable unless asked", () => {
    toast.loading("Checking…", undefined, { id: "l" });
    expect(toast.get()[0].dismissible).toBe(false);
    toast.loading("Updating…", undefined, { id: "l", dismissible: true });
    expect(toast.get()[0].dismissible).toBe(true);
    toast.info("Done", undefined, { id: "l" });
    expect(toast.get()[0].dismissible).toBe(true);
  });

  it("tells the toast why it closed", () => {
    const calls: string[] = [];
    const cb = {
      onDismiss: (t: Toast) => calls.push(`dismiss:${t.id}`),
      onAutoClose: (t: Toast) => calls.push(`auto:${t.id}`),
    };
    toast.show({ id: "x", title: "x", ...cb });
    toast.show({ id: "y", title: "y", ...cb });
    toast.show({ id: "z", title: "z", ...cb });
    toast.show({ id: "w", title: "w", ...cb });
    toast.close("x", "dismiss");
    toast.close("y", "auto");
    toast.close("z", "action");
    toast.dismiss("w");
    expect(calls).toEqual(["dismiss:x", "auto:y"]);
    expect(toast.get()).toHaveLength(0);
    // Closing what's already gone is a no-op, not a second callback.
    toast.close("x", "dismiss");
    expect(calls).toEqual(["dismiss:x", "auto:y"]);
  });

  it("notifies subscribers with a fresh snapshot", () => {
    const seen: number[] = [];
    const un = toast.subscribe((list) => seen.push(list.length));
    const first = toast.get();
    toast.info("One", undefined, { id: "s" });
    expect(toast.get()).not.toBe(first);
    toast.dismiss("s");
    un();
    toast.info("Unheard");
    expect(seen).toEqual([1, 0]);
  });
});
