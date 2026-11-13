// Tasks — one place, one rail, one strip.
//
//   bun test
//
// Three things were true of this surface and are being made untrue here.
//
// 1. SPRINT WAS A LENS. The header strip offered five cells; four of them were
//    ways of LOOKING at the work and the fifth was a dashboard about sprints —
//    a burndown chart, a capacity rollup, a velocity sparkline, a staleness
//    heuristic. It also owned the only two doors in the product for starting a
//    sprint and completing one. Those doors lived in the Tasks rail after
//    that, and went with it when Tasks became the dashboard.
//
// 2. THE LENS LIST AND THE FOLDS THAT READ IT COULD DISAGREE. `WorkLens` is
//    answered by three separate functions — is this a crew lens, which crew
//    view does it mean, which board view does it mean — and by a storage guard.
//    A cell offered on the strip that one of those doesn't answer is a lens you
//    can click into and not come back from; a value one of them answers that
//    the strip doesn't offer is dead code that outlives the cell it served.
//    Exhaustive over `WORK_LENS_VALUES`, so adding a fifth lens fails here
//    until every fold has an answer for it.
//
// 3. THE STRIP WAS ICONS ON ONE SURFACE AND LABELS ON THE OTHER. The board
//    lenses are drawn by `TasksBoard` and the map by `CrewSurface`; each
//    rendered its own switch, and the crew's was the icon-only variant. So the
//    one control that says which drawing you are reading lost its words
//    halfway across its own strip. Both render the same element now.
//
// The strip is two cells today. The map sits behind `CREW_GRAPH_LENS_ENABLED`,
// so everything below is asserted against that flag rather than against a
// hard-coded list: a cell offered without its flag, and a flag that turns
// nothing on, both fail here.

import { describe, expect, test } from "bun:test";

import { CREW_GRAPH_LENS_ENABLED } from "../src/lib/featureFlags";
import {
  WORK_LENSES,
  WORK_LENS_VALUES,
  isCrewLens,
  readWorkLens,
  taskViewFor,
  type WorkLens,
} from "../src/lib/workRoute";
import { readSrc } from "./support/code";

describe("the lens strip", () => {
  test("has no Sprint cell", () => {
    expect(WORK_LENS_VALUES).not.toContain("sprint" as WorkLens);
    for (const opt of WORK_LENSES) {
      expect(opt.value).not.toBe("sprint" as WorkLens);
      expect(opt.label.toLowerCase()).not.toContain("sprint");
    }
  });

  test("opens with the board's own drawings, in strip order", () => {
    // Plan was a fourth cell until it turned out to be List with a different
    // name — see the Tasks collapse. What is left is the drawings that
    // actually differ, and the map only among them when it is switched on.
    expect([...WORK_LENS_VALUES].slice(0, 2)).toEqual(["list", "board"]);
    expect(WORK_LENS_VALUES.includes("graph")).toBe(CREW_GRAPH_LENS_ENABLED);
    expect(WORK_LENS_VALUES).toHaveLength(CREW_GRAPH_LENS_ENABLED ? 3 : 2);
  });

  test("every cell carries a word and a reason, not just a glyph", () => {
    for (const opt of WORK_LENSES) {
      expect(opt.label.trim().length).toBeGreaterThan(0);
      expect((opt.hint ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  test("the values list is the options list, not a second copy", () => {
    expect([...WORK_LENS_VALUES]).toEqual(WORK_LENSES.map((o) => o.value));
  });
});

describe("every lens is answered by every fold", () => {
  test("isCrewLens answers every cell the strip offers", () => {
    const crew = WORK_LENS_VALUES.filter(isCrewLens);
    const board = WORK_LENS_VALUES.filter((l) => !isCrewLens(l));
    expect(board.length).toBeGreaterThan(0);
    expect(crew.length + board.length).toBe(WORK_LENS_VALUES.length);
    // The crew half is the map, offered exactly when its flag says so. A cell
    // on the strip that neither half claims is a lens you can click into and
    // not come back from.
    expect(crew).toEqual(CREW_GRAPH_LENS_ENABLED ? ["graph"] : []);
  });

  test("taskViewFor answers every lens with a view the board draws", () => {
    for (const lens of WORK_LENS_VALUES) {
      expect(["list", "board"]).toContain(taskViewFor(lens));
    }
  });

  test("the map is reachable exactly when its flag says so", () => {
    // There used to be a `crewViewFor` fold here, mapping two crew lenses onto
    // two crew drawings. Plan was the other one, and it went when the Tasks
    // surface collapsed to one list — so the crew owns a single lens, and
    // `isCrewLens` is the one predicate the host and both surfaces branch on.
    // Off, it has to answer no to everything: a predicate that still claims
    // `graph` while the strip has no Graph cell is a surface the app can route
    // to and the user cannot route back from.
    expect(isCrewLens("graph")).toBe(CREW_GRAPH_LENS_ENABLED);
    expect(isCrewLens("list")).toBe(false);
    expect(isCrewLens("board")).toBe(false);
  });

  test("the two board lenses map to their own names", () => {
    expect(taskViewFor("list")).toBe("list");
    expect(taskViewFor("board")).toBe("board");
  });
});

describe("the lens you come back to", () => {
  // A tiny in-memory store standing in for the browser's, so each case can
  // say exactly what was left behind.
  const withStored = (value: string | null, read: () => WorkLens): WorkLens => {
    const prior = (globalThis as { localStorage?: Storage }).localStorage;
    const store = new Map<string, string>();
    if (value !== null) store.set("aura.work.lens", value);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    try {
      return read();
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = prior;
    }
  };

  test("the first open is the Dashboard's board", () => {
    expect(withStored(null, readWorkLens)).toBe("board");
  });

  test("a lens you left is the lens you get back", () => {
    expect(withStored("list", readWorkLens)).toBe("list");
    expect(withStored("board", readWorkLens)).toBe("board");
  });

  test("a retired lens falls back to the board, not to a missing cell", () => {
    for (const gone of ["sprint", "plan", "map"]) {
      expect(withStored(gone, readWorkLens)).toBe("board");
    }
    if (!CREW_GRAPH_LENS_ENABLED) expect(withStored("graph", readWorkLens)).toBe("board");
  });
});

describe("both surfaces render the same strip", () => {
  test("neither reaches for the icon-only switch", async () => {
    // The crew page draws its strip through `CrewViewBars`, the Dashboard's
    // strip and toolbar for that lens; the board draws it inline.
    for (const rel of [
      "components/TasksBoard.tsx",
      "components/tasks/CrewViewBars.tsx",
    ]) {
      const src = await readSrc(rel);
      expect(src).toContain("<WorkLensTabs");
      expect(src).toContain("<TaskViewStrip");
      expect(src).toContain("<TaskToolbar");
      // `BoardLayoutSwitch size="sm"` is the 28px icon-only variant. A surface
      // that still imports it is a surface that can still draw it.
      expect(src).not.toContain("BoardLayoutSwitch");
    }
    const crew = await readSrc("components/commons/crew/CrewSurface.tsx");
    expect(crew).toContain("<CrewViewBars");
    expect(crew).not.toContain("BoardLayoutSwitch");
    // No second strip in the frame's header above the shared one.
    expect(crew).not.toMatch(/tabs=\{<WorkLensTabs/);
  });

  test("the strip itself renders the shared tab control, labels and all", async () => {
    const src = await readSrc("components/tasks/WorkLensTabs.tsx");
    // `ViewTabs`, not `Segment`: a surface header's view switch sits ON the
    // bar's rule. Segment keeps its track for the toggle groups that live
    // inside a page, where the track is the only thing saying "control".
    expect(src).toContain("ViewTabs");
    expect(src).toContain("WORK_LENSES");
    expect(src).toContain("label: opt.label");
  });
});

describe("the Sprint page is gone", () => {
  test("the board no longer draws a sprint view", async () => {
    const src = await readSrc("components/TasksBoard.tsx");
    for (const gone of [
      "SprintView",
      "Burndown",
      "VelocitySparkline",
      "CapacityBars",
      'drawing === "sprint"',
    ]) {
      expect(src).not.toContain(gone);
    }
  });

  test("the sprint rail went with the rail", async () => {
    // Tasks is the dashboard now: no rail beside it, so no sprint group in one.
    for (const gone of [
      "components/tasks/SprintRailGroup.tsx",
      "components/tasks/CreateSprintWizard.tsx",
      "components/tasks/CloseSprintPanel.tsx",
      "components/workpanes/TasksSidebar.tsx",
    ]) {
      expect(await Bun.file(`${import.meta.dir}/../src/${gone}`).exists()).toBe(false);
    }
  });

});
