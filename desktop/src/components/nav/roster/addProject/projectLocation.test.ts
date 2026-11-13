import { describe, expect, test } from "bun:test";
import { isPrimaryChord, projectSlug } from "./projectLocation";

describe("projectSlug", () => {
  test("lower-cases and dashes what a folder name cannot hold", () => {
    expect(projectSlug("My Awesome Project")).toBe("my-awesome-project");
    expect(projectSlug("api_v2.service")).toBe("api-v2-service");
  });
  test("collapses runs and trims the ends", () => {
    expect(projectSlug("  --hello!!world--  ")).toBe("hello-world");
  });
  test("is empty when nothing usable is left", () => {
    expect(projectSlug("!!!")).toBe("");
    expect(projectSlug("")).toBe("");
  });
  test("stops at a hundred characters", () => {
    expect(projectSlug("a".repeat(140))).toHaveLength(100);
  });
});

describe("isPrimaryChord", () => {
  test("⌘↵ and Ctrl↵ submit, a bare Enter does not", () => {
    expect(isPrimaryChord({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPrimaryChord({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPrimaryChord({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isPrimaryChord({ key: "a", metaKey: true, ctrlKey: false })).toBe(false);
  });
});
