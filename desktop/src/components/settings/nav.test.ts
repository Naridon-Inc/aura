import { describe, expect, test } from "bun:test";
import { navigationGroups, visiblePages } from "./nav";

const ROOTS = Array.from({ length: 30 }, (_, i) => `/Users/me/code/project-${i + 1}`);

const labels = (roots: string[], query = "") => navigationGroups(roots, query).map((group) => group.label);

describe("settings page list order", () => {
  test("Organization and Services come before the repositories, More after them", () => {
    expect(labels(ROOTS)).toEqual([
      "Personal",
      "Agents & environment",
      "Organization",
      "Services",
      "Repositories",
      "More",
    ]);
  });

  test("Billing is reachable before any repository, however many there are", () => {
    const pages = visiblePages(navigationGroups(ROOTS, ""));
    const billing = pages.indexOf("billing");
    const firstRepo = pages.findIndex((id) => id.startsWith("repo:") || id.includes("/code/project-"));
    expect(billing).toBeGreaterThan(-1);
    expect(firstRepo).toBeGreaterThan(-1);
    expect(billing).toBeLessThan(firstRepo);
  });

  test("with no repositories the Repositories group is left out", () => {
    expect(labels([])).toEqual(["Personal", "Agents & environment", "Organization", "Services", "More"]);
  });
});

describe("settings search", () => {
  test("searching billing finds the Billing page", () => {
    const groups = navigationGroups(ROOTS, "billing");
    const org = groups.find((group) => group.label === "Organization");
    expect(org?.items.map((item) => item.id)).toContain("billing");
  });

  test("searching stripe or upgrade still lands on Billing", () => {
    for (const q of ["stripe", "upgrade", "Subscription"]) {
      const ids = visiblePages(navigationGroups([], q));
      expect(ids).toContain("billing");
    }
  });

  test("a search that only matches a repository keeps that repository and drops the rest", () => {
    const groups = navigationGroups(ROOTS, "project-7");
    const repos = groups.find((group) => group.label === "Repositories");
    expect(repos?.items.map((item) => item.label)).toContain("project-7");
    expect(groups.find((group) => group.label === "Organization")).toBeUndefined();
  });
});
