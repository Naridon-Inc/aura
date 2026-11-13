// Settings > Advanced drew nothing at all when the settings failed to load:
// the whole page, Help & about included, hung on the loaded settings, though
// Help reads none of them. The one page that says how to report a problem
// vanished exactly when there was one to report.
//
//   bun test

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

describe("Advanced when the settings did not load", () => {
  test("still draws Help & about", async () => {
    const src = await readSrc("components/settings/SettingsPageView.tsx");
    const advanced = src.slice(src.indexOf('case "advanced"'), src.indexOf('case "terminal"'));
    expect(advanced).toContain("<HelpPage");
    expect(advanced).not.toContain(") : null;");
    expect(advanced).toContain(") : (\n        help\n      );");
  });
});
