import { describe, expect, test } from "bun:test";

import type { Machine } from "../../../lib/api";
import { placesOfMachines } from "../../../lib/place";
import { machinePlaceEntries } from "../PlaceSwitchItems";
import { arrangeMachineSections, machineSections } from "./MachinePlaceRoster";

const machine = (over: Partial<Machine>): Machine => ({
  id: "ubuntu@runner",
  name: "runner",
  host: "runner.example",
  user: "ubuntu",
  key_path: "",
  box_kind: "ssh",
  repo_path: null,
  project_root: null,
  repo_branch: null,
  added_at: 1,
  last_used_at: 1,
  ...over,
});

describe("machineSections", () => {
  const [onApp, onOther, loose] = placesOfMachines([
    machine({ id: "a", repo_branch: "menu" }),
    machine({ id: "b", name: "gpu" }),
    machine({ id: "a", name: "runner" }),
  ]);

  test("only the machine's own workspaces, filed by repository, unfiled last", () => {
    const byRoot = new Map([["/code/app", [onApp!, onOther!]]]);
    const sections = machineSections("a", byRoot, [loose!]);
    expect(sections.map((s) => [s.key, s.root, s.places.length])).toEqual([
      [":machine:/code/app", "/code/app", 1],
      [":machine:a", null, 1],
    ]);
  });

  test("a machine with nothing on the list has no sections", () => {
    expect(machineSections("zzz", new Map([["/code/app", [onApp!]]]), [])).toEqual([]);
  });
});

describe("arrangeMachineSections", () => {
  const places = placesOfMachines([
    machine({ id: "a", repo_path: "/srv/app", added_at: 10, last_used_at: 30 }),
    machine({ id: "a", repo_path: "/srv/api", added_at: 20, last_used_at: 25 }),
    machine({ id: "a", repo_path: "/srv/web", added_at: 5, last_used_at: 40 }),
  ]);
  const sections = [
    { key: ":machine:/code/app", root: "/code/app", places: [places[0]!, places[1]!] },
    { key: ":machine:a", root: null, places: [places[2]!] },
  ];
  const paths = (out: ReturnType<typeof arrangeMachineSections>) =>
    out.map((s) => s.places.map((p) => p.project.path));

  test("sorted by last used, or by added", () => {
    expect(paths(arrangeMachineSections(sections, "updated", null))).toEqual([
      ["/srv/app", "/srv/api"],
      ["/srv/web"],
    ]);
    expect(paths(arrangeMachineSections(sections, "created", null))[0]).toEqual([
      "/srv/api",
      "/srv/app",
    ]);
  });

  test("a filter naming a repository here keeps only its section", () => {
    expect(arrangeMachineSections(sections, "updated", "/code/app").map((s) => s.key)).toEqual([
      ":machine:/code/app",
    ]);
  });

  test("a filter naming a repository not here lists everything", () => {
    expect(arrangeMachineSections(sections, "updated", "/code/gone")).toHaveLength(2);
  });
});

test("the switcher lists each machine once", () => {
  const entries = machinePlaceEntries([
    machine({ id: "a", repo_path: "/srv/app" }),
    machine({ id: "a", repo_path: "/srv/api" }),
    machine({ id: "b", name: "gpu", user: "me", host: "gpu.example" }),
  ]);
  expect(entries).toEqual([
    { machineId: "a", name: "runner", at: "ubuntu@runner.example" },
    { machineId: "b", name: "gpu", at: "me@gpu.example" },
  ]);
});
