import { describe, expect, test } from "bun:test";
import { mermaidCacheKey, mermaidConfig } from "./mermaidRender";

describe("mermaid drawing settings", () => {
  test("the base theme recoloured to the app, strict and never on load", () => {
    const dark = mermaidConfig("dark");
    expect(dark).toMatchObject({ startOnLoad: false, securityLevel: "strict", theme: "base", darkMode: true });
    expect(dark.themeVariables).toEqual({
      background: "#131110",
      primaryColor: "#2C2826",
      primaryTextColor: "#EAE8E6",
      primaryBorderColor: "#454038",
      lineColor: "#766F6B",
      textColor: "#EAE8E6",
    });
    const light = mermaidConfig("light");
    expect(light.darkMode).toBe(false);
    expect(light.themeVariables.background).toBe("#FFFFFF");
    expect(light.themeVariables.textColor).toBe("#2C2826");
  });

  test("a diagram is remembered per source and per theme", () => {
    expect(mermaidCacheKey("graph TD; A-->B", "dark")).not.toBe(mermaidCacheKey("graph TD; A-->B", "light"));
    expect(mermaidCacheKey("a", "dark")).toBe(mermaidCacheKey("a", "dark"));
  });
});
