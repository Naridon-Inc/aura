import { describe, expect, test } from "bun:test";
import { afterMenuClose } from "./after-menu-close";

function closeEvent() {
  let prevented = false;
  return {
    event: { preventDefault: () => (prevented = true) } as unknown as Event,
    prevented: () => prevented,
  };
}

function frames() {
  const queued: (() => void)[] = [];
  return {
    schedule: (run: () => void) => void queued.push(run),
    flush: () => queued.splice(0).forEach((run) => run()),
    size: () => queued.length,
  };
}

describe("afterMenuClose", () => {
  test("a deferred item runs only after the menu's close, a frame later", () => {
    const frame = frames();
    const menu = afterMenuClose(frame.schedule);
    const ran: string[] = [];
    menu.later(() => ran.push("open popover"))?.();
    expect(ran).toEqual([]);

    const close = closeEvent();
    menu.onCloseAutoFocus(close.event);
    expect(close.prevented()).toBe(true);
    expect(ran).toEqual([]);

    frame.flush();
    expect(ran).toEqual(["open popover"]);
  });

  test("with nothing deferred the menu hands focus back as usual", () => {
    const frame = frames();
    const menu = afterMenuClose(frame.schedule);
    const close = closeEvent();
    menu.onCloseAutoFocus(close.event);
    expect(close.prevented()).toBe(false);
    expect(frame.size()).toBe(0);
  });

  test("a deferred action runs once; the next close returns focus again", () => {
    const frame = frames();
    const menu = afterMenuClose(frame.schedule);
    let runs = 0;
    menu.defer(() => runs++);
    menu.onCloseAutoFocus(closeEvent().event);
    frame.flush();

    const again = closeEvent();
    menu.onCloseAutoFocus(again.event);
    frame.flush();
    expect(runs).toBe(1);
    expect(again.prevented()).toBe(false);
  });

  test("later() of nothing is no item handler at all", () => {
    expect(afterMenuClose().later(undefined)).toBeUndefined();
  });
});
