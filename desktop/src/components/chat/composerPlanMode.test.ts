// Run with: bun test src/components/chat/composerPlanMode.test.ts
//
// Plan mode is shown by the box itself, not by a chip in the footer. The
// composer gets a plan-tinted fill with 45° stripes that fade out over its
// first 72px, and the running strip docked on top takes the same tint, so the
// two still read as one piece. Leaving plan mode is done from the + menu
// ("Exit plan mode"), Shift+Tab or /plan.
//
// The markup half renders the shared composer. The stylesheet half is a
// source scan, because the bug it guards against is the attribute being set
// with no rule behind it, or the strip keeping its plain fill on top of a
// tinted box.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../ui/composer";

const SRC = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const noop = () => {};
const render = (planMode: boolean) =>
  renderToStaticMarkup(
    createElement(Composer, {
      value: "",
      onChange: noop,
      onSend: noop,
      planMode,
      onPlanModeChange: noop,
    }),
  );

describe("plan mode is the composer's own look", () => {
  test("the box and its wrapper are marked while plan mode is on", () => {
    const on = render(true);
    expect(on).toMatch(/class="ui-composer-wrap[^"]*"[^>]*data-plan-mode="true"/);
    expect(on).toMatch(/class="ui-composer"[^>]*data-plan-mode="true"/);
    expect(render(false)).not.toContain("data-plan-mode");
  });

  test("there is no plan chip in the footer", () => {
    expect(render(true)).not.toContain("Plan mode");
  });

  test("the stylesheet draws the striped plan fill", () => {
    const css = read("components/ui/interface.css");
    expect(css).toContain(
      "--ui-plan-fill: color-mix(in srgb, var(--ui-plan-border) 12%, var(--ui-muted));",
    );
    const rule = css.slice(css.indexOf(".ui-composer[data-plan-mode] {"));
    expect(rule).toMatch(/linear-gradient\(to bottom, transparent 0, var\(--ui-plan-fill\) 72px\)/);
    expect(rule).toMatch(
      /repeating-linear-gradient\(\s*45deg,\s*color-mix\(in srgb, var\(--ui-plan-border\) 9%, transparent\) 0 7px,\s*transparent 7px 15px\s*\)/,
    );
  });

  test("a running strip docked on a plan-mode box takes the same fill", () => {
    const css = read("components/ui/live-strips.css");
    expect(css).toMatch(
      /\.ui-running-docked:has\(\+ \[data-os-drop="composer"\] > \.ui-composer-wrap\[data-plan-mode\]\)\s*\{\s*background: var\(--ui-plan-fill\);/,
    );
  });
});
