// The place rails' project switcher, and why it did nothing.
//
//   bun test
//
// Every place rail — Pages, Team, Tasks — carries a project picker, because the
// things a rail lists (documents, conversations, tasks, sprints, goals) belong
// to a project. It writes ONE shared scope (`lib/projectRoots`). The bodies are
// supposed to read that scope, and the invariant is the one in that file's own
// header: a rail counting one set over a body drawing another is worse than a
// rail with no picker at all.
//
// It shipped broken in three different ways, and none of them was the store.
//
// 1. TEAM DIDN'T NARROW — IT THREW. `App` resolved the scope into `placeRoot`
//    and handed it to `TeamSurface`, but mounted `TeamChatProvider` on
//    `project.root`, the folder the app has open. `TeamSurface` asserts the
//    chat model it draws was built for the root it was handed — a real
//    invariant, since a model for project A rendered as project B would file
//    messages into the wrong repo. So picking any other project made those two
//    disagree and the assertion threw. The switcher didn't fail to narrow; it
//    took the surface down.
//
// 2. TASKS NARROWED HALF ITSELF. `TasksBoard` reads the scope directly, so List
//    and Board followed the picker. The crew surface behind Plan and Graph
//    takes a single root and was handed `project.root` — so the same pick moved
//    two lenses of four. That is also why the crew surface had grown a SECOND
//    project picker of its own: a control invented to work around the first one
//    not reaching it.
//
// 3. PAGES KEPT THE OLD PROJECT'S PAGE. The editor restores the last-open page
//    on a repo switch, but bailed early when the new project had none — leaving
//    the previous project's document open above the new project's tree, where a
//    keystroke would have saved it into the wrong repo.
//
// The fold below is the fix's load-bearing half: one pure function that says
// which project a place is pointed at. The source pins are the other half —
// they catch a body wired to something OTHER than that answer, which is what
// every one of the three failures actually was.

import { describe, expect, test } from "bun:test";

import {
  ALL_PROJECTS,
  placeProjectName,
  placeRootOf,
  projectNameFromRoot,
  rootsForScope,
} from "../src/lib/projectRoots";
import { readSrc } from "./support/code";

const OPEN = "/Users/me/Documents/New Git";
const OTHER = "/Users/me/Documents/Shopify";
const KNOWN = [
  { root: OPEN, label: "New Git" },
  { root: OTHER, label: "Shopify" },
  { root: "/Users/me/AuraProjects/recipe-box" },
];

describe("which project is this place pointed at", () => {
  test("nothing picked = the folder the app has open", () => {
    expect(placeRootOf("", OPEN, KNOWN)).toBe(OPEN);
  });

  test("a picked project is THE answer, not a hint the body may ignore", () => {
    // The regression. Every failure above ended with a body drawing OPEN while
    // the rail said OTHER.
    expect(placeRootOf(OTHER, OPEN, KNOWN)).toBe(OTHER);
  });

  test("a project the registry hasn't listed still wins", () => {
    // The scope is authoritative on its own; a body must not quietly fall back
    // because discovery hasn't answered yet.
    expect(placeRootOf("/Users/me/somewhere-new", OPEN, KNOWN)).toBe(
      "/Users/me/somewhere-new",
    );
  });

  test("All projects falls back to one, for surfaces that read one", () => {
    // A page editor saves into one repo and a dependency graph belongs to one
    // project; neither can honour "all". Falling back to the open project is
    // the honest single answer — and the surface says so on screen.
    expect(placeRootOf(ALL_PROJECTS, OPEN, KNOWN)).toBe(OPEN);
  });

  test("All projects with nothing known is still the open project", () => {
    expect(placeRootOf(ALL_PROJECTS, OPEN, [])).toBe(OPEN);
  });

  test("no scope and no open project is empty, not a crash", () => {
    expect(placeRootOf("", "", [])).toBe("");
  });

  test("the multi-root read and the single-root read agree when there is one", () => {
    // `rootsForScope` is what the board (which CAN draw several) reads, and
    // `placeRootOf` is what everything else reads. Outside All projects they
    // must name the same project or the rail's counts and the body's cards are
    // claims about different sets.
    for (const scope of ["", OPEN, OTHER]) {
      const roots = rootsForScope(scope, OPEN, KNOWN);
      expect(roots).toHaveLength(1);
      expect(roots[0]).toBe(placeRootOf(scope, OPEN, KNOWN));
    }
  });
});

describe("what to call it", () => {
  test("the registry's own label wins. One project, one name", () => {
    expect(placeProjectName(OTHER, KNOWN)).toBe("Shopify");
  });

  test("a caller's name for THIS root fills a missing label", () => {
    expect(placeProjectName("/Users/me/x", [], "Ex Project")).toBe("Ex Project");
  });

  test("a labelled root ignores the caller's fallback", () => {
    // The fallback is the OPEN project's name at the one call site that passes
    // it; letting it beat a real label is how the old bug read — the name of
    // the project you left, over the project you picked.
    expect(placeProjectName(OTHER, KNOWN, "New Git")).toBe("Shopify");
  });

  test("with neither, the path's last segment", () => {
    expect(placeProjectName("/Users/me/AuraProjects/recipe-box", KNOWN)).toBe(
      "recipe-box",
    );
    expect(placeProjectName("/a/b/c", [])).toBe(projectNameFromRoot("/a/b/c"));
  });

  test("a blank label is not a name", () => {
    // A registry row with a whitespace label must fall through to the path,
    // not render the rail's project as an empty string.
    const root = "/Users/me/repos/acme-web";
    expect(placeProjectName(root, [{ root, label: "   " }])).toBe("acme-web");
  });
});

describe("every body is wired to that answer", () => {
  test("Team's chat model is built for the place root, not the open folder", async () => {
    const app = await readSrc("App.tsx");
    expect(app).toContain("<TeamChatProvider repoRoot={placeRoot}");
    // The exact shape that threw.
    expect(app).not.toContain("<TeamChatProvider repoRoot={project.root}");
    // …and the surface it feeds is handed the same root.
    expect(app).toContain("<TeamSurface repoRoot={placeRoot}");
  });

  test("Team opened as a pane names the same root as the provider", async () => {
    const ws = await readSrc("components/WorkSurface.tsx");
    expect(ws).toContain("usePlaceRoot");
    expect(ws).toContain("<TeamSurface repoRoot={placeRoot}");
    expect(ws).not.toContain("<TeamSurface repoRoot={pane.repoRoot}");
  });

  test("the crew lenses take the rail's project, not the open one", async () => {
    const place = await readSrc("components/tasks/TasksPlace.tsx");
    expect(place).toContain("usePlaceRoot");
    // Whatever the local name, the root handed down must be the resolved one.
    // (It was `crewRoot` when this was written and is `placeRoot` now — the
    // assertion pins the wiring, not the identifier.)
    expect(place).toMatch(/<CrewSurface[\s\S]{0,120}?repoRoot=\{placeRoot\}/);
    expect(place).not.toMatch(/<CrewSurface[\s\S]{0,120}?repoRoot=\{repoRoot\}/);
  });

  test("Trace-as-a-page follows the scope; a Trace pane names it and stops", async () => {
    // Trace is the surface where the wrong project is worst — every
    // destination under it is a claim about history, and one repo's timeline
    // looks exactly as authoritative as another's. So the strip carries the
    // switcher, and the page under it has to be reading the same answer.
    const app = await readSrc("App.tsx");
    const mount = app.slice(app.indexOf("<TracePage"));
    expect(mount).toContain("repoRoot={placeRoot || project.root}");
    expect(mount.slice(0, 400)).not.toContain("repoRoot={project.root}");

    const page = await readSrc("components/trace/TracePage.tsx");
    expect(page).toContain("switchProject");

    // The pane host is the other half of the invariant: it reads the window's
    // repo, which the shared scope does not move, so it names the project and
    // offers no control. A switcher whose surface ignores it is the exact
    // failure this file was opened for.
    const ws = await readSrc("components/WorkSurface.tsx");
    const strip = ws.slice(ws.indexOf("<TraceTabs"));
    expect(strip.slice(0, 500)).toContain("repoRoot={repoRoot}");
    expect(strip.slice(0, 500)).not.toContain("switchProject");
  });

  test("Pages clears the editor when the new project has no page open", async () => {
    const pages = await readSrc("components/pages2/PagesSurface.tsx");
    // The restore-on-repo-switch effect must CLEAR, not bail. Bailing is what
    // stranded the previous project's document over the new project's tree.
    expect(pages).toMatch(
      /const key = lastOpenPageKey\(repoRoot\);[\s\S]{0,200}?if \(!key \|\| !parsed\) \{[\s\S]{0,400}?setActiveKey\(null\);[\s\S]{0,200}?setBody\(""\);/,
    );
  });
});

describe("one picker per place", () => {
  test("the crew surface no longer draws a second one", async () => {
    const src = await readSrc("components/commons/crew/CrewSurface.tsx");
    for (const gone of [
      "CrewProjectStrip",
      "projectTab",
      "crewProjects",
      "CREW_CROSS_PROJECT",
      "refreshProjects",
    ]) {
      expect(src).not.toContain(gone);
    }
  });

  test("its aggregation module went with it", async () => {
    expect(
      await Bun.file(
        `${import.meta.dir}/../src/components/commons/crew/crewProjects.ts`,
      ).exists(),
    ).toBe(false);
  });

  test("the flag that gated it is gone too. No dead switch", async () => {
    const flags = await readSrc("lib/featureFlags.ts");
    expect(flags).not.toContain("CREW_CROSS_PROJECT");
  });

  test("under All projects the crew lenses say which project they drew", async () => {
    // The rail can count eight; a dependency graph is one project's. Silently
    // drawing one under a rail claiming eight is the disagreement the picker
    // exists to prevent, so the surface names it.
    const src = await readSrc("components/commons/crew/CrewSurface.tsx");
    expect(src).toContain("isAllProjects");
    // The sentence has been reworded since; what has to survive is that it
    // says "one project at a time" AND names which one.
    expect(src).toContain("one project at a time");
    expect(src).toContain("{projectName}");
  });
});

describe("the picker looks like a menu", () => {
  test("the trigger carries the house chevron", async () => {
    const src = await readSrc("components/ui/select.tsx");
    expect(src).toContain("ChevronDown");
    expect(src).toContain("ade-select-caret");
    expect(src).toContain("ade-select-trigger");
  });

  test("Medusa's up/down stepper triangles are suppressed", async () => {
    // AURA-33: the rail's picker wore a stacked up/down pair — the glyph a
    // NUMBER STEPPER wears — so it read as something you nudge rather than
    // something you open.
    const css = await Bun.file(`${import.meta.dir}/../src/styles.css`).text();
    expect(css).toContain(".ade-select-trigger > svg:last-child");
    expect(css).toContain(".ade-select-trigger > svg.ade-select-caret");
  });
});
