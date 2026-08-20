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
//    sprint and completing one, so deleting it naively would have left the rail
//    listing an object nothing could make or finish. The arithmetic behind
//    those two doors moved to `lib/sprintScope` and is pinned below.
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
// 3. THE STRIP WAS ICONS ON ONE SURFACE AND LABELS ON THE OTHER. Two of the
//    four lenses are drawn by `TasksBoard` and two by `CrewSurface`; each
//    rendered its own switch, and the crew's was the icon-only variant. So the
//    one control that says which of four drawings you are reading lost its
//    words halfway across its own strip. Both render the same element now.

import { describe, expect, test } from "bun:test";

import {
  WORK_LENSES,
  WORK_LENS_VALUES,
  isCrewLens,
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

  test("offers exactly the three drawings, in strip order", () => {
    // Plan was a fourth cell until it turned out to be List with a different
    // name — see the Tasks collapse. The strip is the three drawings that
    // actually differ.
    expect([...WORK_LENS_VALUES]).toEqual(["list", "board", "graph"]);
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
  test("isCrewLens splits the strip in two, and neither half is empty", () => {
    const crew = WORK_LENS_VALUES.filter(isCrewLens);
    const board = WORK_LENS_VALUES.filter((l) => !isCrewLens(l));
    expect(crew.length).toBeGreaterThan(0);
    expect(board.length).toBeGreaterThan(0);
    expect(crew.length + board.length).toBe(WORK_LENS_VALUES.length);
  });

  test("taskViewFor answers every lens with a view the board draws", () => {
    for (const lens of WORK_LENS_VALUES) {
      expect(["list", "board"]).toContain(taskViewFor(lens));
    }
  });

  test("the crew half is exactly Graph", () => {
    // There used to be a `crewViewFor` fold here, mapping two crew lenses onto
    // two crew drawings. Plan was the other one, and it went when the Tasks
    // surface collapsed to one list — so the crew owns a single lens now and a
    // mapping with one entry is just the entry. This is the assertion that has
    // to hold either way: whatever `isCrewLens` claims, the crew surface draws.
    expect(WORK_LENS_VALUES.filter(isCrewLens)).toEqual(["graph"]);
  });

  test("the two board lenses map to their own names", () => {
    expect(taskViewFor("list")).toBe("list");
    expect(taskViewFor("board")).toBe("board");
  });
});

describe("both surfaces render the same strip", () => {
  test("neither reaches for the icon-only switch", async () => {
    for (const rel of [
      "components/TasksBoard.tsx",
      "components/commons/crew/CrewSurface.tsx",
    ]) {
      const src = await readSrc(rel);
      expect(src).toContain("<WorkLensTabs");
      // `BoardLayoutSwitch size="sm"` is the 28px icon-only variant. A surface
      // that still imports it is a surface that can still draw it.
      expect(src).not.toContain("BoardLayoutSwitch");
    }
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

describe("the Sprint page is gone, its lifecycle is not", () => {
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

  test("starting and completing a sprint still have a door", async () => {
    const src = await readSrc("components/tasks/SprintRailGroup.tsx");
    expect(src).toContain("CreateSprintWizard");
    expect(src).toContain("CloseSprintPanel");
    expect(src).toContain("tasksCycleClose");
    // And the rail actually mounts it — a door in a file nothing renders is
    // the same as no door.
    const rail = await readSrc("components/workpanes/TasksSidebar.tsx");
    expect(rail).toContain("<SprintRailGroup");
  });
});
