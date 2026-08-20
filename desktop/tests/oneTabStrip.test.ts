// One tab strip, one height, everywhere it lands.
//
//   bun test
//
// The strip that says which drawing of a surface you're reading was drawn at
// two sizes. Tasks put it in the shared `SurfaceHeader` — 44px, one hairline,
// a 12px left inset. Trace built its own bar out of raw utilities at 36px and
// put the identical control in it. Same component, same job, two heights and
// two left edges, one click apart in the sidebar.
//
// That is the exact defect `SurfaceHeader` was extracted to end, and its own
// header comment says so: "Not a style guideline anyone has to remember: the
// same element, so drift isn't possible." Trace was the surface that hadn't
// been moved over yet, so the guarantee was only true of the pages that
// happened to have been.
//
// Three things are pinned here.
//
// 1. BOTH STRIPS GO THROUGH THE SHARED BAR. Not "both are 44px" — heights
//    written down twice drift, which is how this started. The assertion is
//    that neither file draws a bar of its own.
//
// 2. THE HEIGHT IS ONE NUMBER. `SurfaceHeader` and `.ade-tabs` both need it:
//    the bar sets it, the strip must not be shorter than it, or a tab's accent
//    rail floats above the rule instead of landing on it. Both read
//    `--surface-header-h`.
//
// 3. CELLS DON'T SHRINK. Trace has seven places and they do not fit a ~750px
//    surface. A flex row's default is to squeeze them, which clipped "Project
//    timeline" mid-word and slid the impacts badge on top of its neighbour.
//    They keep their width and the strip scrolls — which is only honest if the
//    selected cell is scrolled into view, so that is pinned too.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const CSS = await Bun.file(`${import.meta.dir}/../src/styles.css`).text();

describe("every surface header is the same header", () => {
  test("Trace's strip renders the shared bar, not one of its own", async () => {
    const src = await readSrc("components/trace/TraceTabs.tsx");
    expect(src).toContain("<SurfaceHeader");
    // The bar it used to draw: a flex row with its own height and its own
    // bottom rule. Any of those three back in this file is the drift again.
    expect(src).not.toContain("min-h-9");
    expect(src).not.toContain("border-b border-line-soft px-3");
  });

  test("Tasks' strip renders the same control Trace does", async () => {
    const src = await readSrc("components/tasks/WorkLensTabs.tsx");
    expect(src).toContain("ViewTabs");
    const trace = await readSrc("components/trace/TraceTabs.tsx");
    expect(trace).toContain("ViewTabs");
  });

  test("Workspaces' lens switch is a tab strip, not a segmented track", async () => {
    const src = await readSrc("components/workspaces/WorkspacesSurface.tsx");
    expect(src).toContain("<FleetLensTabs");
    // It hand-rolled the right rail's track markup. A track is for a toggle
    // INSIDE a page; a lens switch in a surface header answers "which page",
    // and the header's own hairline is the line it belongs on — a track here
    // draws a box inside a bar.
    expect(src).not.toContain('className="ade-seg ade-seg--row"');
    // And the strip itself is the shared one, not a fourth drawing of it.
    const strip = await readSrc("components/workspaces/FleetLensTabs.tsx");
    expect(strip).toContain("<ViewTabs");
  });

  test("every Workspaces lens carries a glyph and a tooltip, like Tasks'", async () => {
    const src = await readSrc("components/workspaces/FleetLensTabs.tsx");
    // The glyphs are Tasks' glyphs on purpose: a list grouped by time and a set
    // of status lanes are the same two drawings on both surfaces, so a reader
    // who learned the strip on one has learned it on the other. Reaching for a
    // different mark for the same idea is the drift this pins shut.
    const tasks = await readSrc("lib/workRoute.ts");
    for (const glyph of ["List", "KanbanSquare"]) {
      expect(src).toContain(glyph);
      expect(tasks).toContain(glyph);
    }
    // Live is the one lens that asks the backend who is standing in each copy
    // right now, so it wears a pulse rather than a layout glyph.
    expect(src).toContain("Activity");
    // Three lenses, three glyphs, three hints — a label alone is not the only
    // way to learn a tab.
    expect(src.match(/^\s+icon: \w+,$/gm)).toHaveLength(3);
    expect(src.match(/^\s+hint: "/gm)).toHaveLength(3);
    expect(src).toContain("title: hint");
  });

  test("a detail pane's tabs are the same strip, not the wizard's step cells", async () => {
    const src = await readSrc("components/ui/wizard.tsx");
    // `variant="tabs"` was a view switch wearing the wizard's clothes: no
    // progress glyph, no jump gate, nothing sequential — but 52px cells that
    // stretched to fill. That made the Session, PR and Task detail panes the
    // only surfaces in the app with a header 8px taller than everywhere else.
    expect(src).toContain("<ViewTabs");
    const steps = src.slice(src.indexOf("if (isTabs)"));
    // The wizard cell survives, because a sequential flow with a status glyph
    // per step genuinely is a different control. It just must not be what a
    // tab renders any more.
    expect(steps).toContain("h-[52px]");
    expect(src.slice(0, src.indexOf("if (isTabs)"))).not.toContain("h-[52px]");
  });

  test("the height is a token, and both readers read it", async () => {
    expect(CSS).toContain("--surface-header-h: 44px");
    const header = await readSrc("components/ui/SurfaceHeader.tsx");
    expect(header).toContain("var(--surface-header-h)");
    // A Tailwind height step here is a second copy of the number.
    expect(header).not.toContain("min-h-11");

    const tabs = CSS.slice(CSS.indexOf(".ade-tabs {"));
    expect(tabs.slice(0, tabs.indexOf("}"))).toContain(
      "min-height: var(--surface-header-h)",
    );
  });
});

describe("a tab keeps its width and the strip scrolls", () => {
  const cell = (() => {
    const at = CSS.indexOf(".ade-tabs > button {");
    return CSS.slice(at, CSS.indexOf("}", at));
  })();

  test("cells are not squeezed to fit the bar", () => {
    expect(cell).toContain("flex: 0 0 auto");
  });

  test("a short label still gets a target worth pressing", () => {
    // "List" is four characters and came out visibly narrower than "Graph"
    // beside it, which made an evenly-weighted strip look ragged.
    expect(cell).toContain("min-width: 84px");
    expect(cell).toContain("padding: 0 16px");
  });

  test("selected reads as the brightest ink, not as the brand green", () => {
    // Green is the accent: the primary button, the thing Aura wants your click
    // on. Where you already are is not an action, so painting the selected tab
    // green put a call to action on the one cell in the strip you cannot go to.
    const active = (() => {
      const at = CSS.indexOf(".ade-tabs > button.active {");
      return CSS.slice(at, CSS.indexOf("}", at));
    })();
    expect(active).toContain("color: var(--color-text-1)");
    expect(active).not.toContain("--color-accent");

    const rail = (() => {
      const at = CSS.indexOf(".ade-tabs > button.active::after {");
      return CSS.slice(at, CSS.indexOf("}", at));
    })();
    // Not a literal white: the strip has to work on both grounds, and
    // `--color-text-1` is near-white in dark and near-black ink in light. A
    // hard-coded #fff vanishes against the light header.
    expect(rail).toContain("background: var(--color-text-1)");
    expect(rail).not.toContain("#fff");
  });

  test("the strip scrolls itself rather than widening the bar", async () => {
    // Cells refuse to shrink, so a strip with more places than fit is wider
    // than the slot it was handed. Without an overflow box of its own it just
    // spills: the header grows, and the whole surface scrolls sideways to make
    // room for a tab bar. `ViewTabs` always had the JS to scroll the selected
    // cell into view, but it measures `scrollWidth > clientWidth`, and on a
    // `visible` box those are equal — so it quietly did nothing.
    const tabs = (() => {
      const at = CSS.indexOf(".ade-tabs {");
      return CSS.slice(at, CSS.indexOf("}", at));
    })();
    expect(tabs).toContain("overflow-x: auto");
    // An inline-flex flex-item floors at its content width, which spills before
    // the overflow can ever engage.
    expect(tabs).toContain("min-width: 0");
    // A 10px track inside a 44px header eats a quarter of the bar.
    expect(tabs).toContain("scrollbar-width: none");

    // And it belongs to the component, not to whoever remembered. Trace was
    // the only strip that scrolled, because Trace alone hand-passed the
    // utility class — the same one-surface-remembered drift the shared strip
    // exists to end.
    for (const file of [
      "components/trace/TraceTabs.tsx",
      "components/tasks/WorkLensTabs.tsx",
      "components/workspaces/FleetLensTabs.tsx",
      "components/ui/wizard.tsx",
    ]) {
      expect(await readSrc(file)).not.toContain("overflow-x-auto");
    }
  });

  test("the selected tab is brought into view when the strip overflows", async () => {
    // The scrolling itself moved to `useStripOverflow` when the conversation
    // header turned out to need the identical behaviour; `ViewTabs` says which
    // cell is the selected one and the hook does the rest.
    const src = await readSrc("components/ui/tabs.tsx");
    expect(src).toContain('activeSelector: \'[aria-selected="true"]\'');
    const strip = await readSrc("components/ui/stripOverflow.tsx");
    expect(strip).toContain("scrollLeft");
    // Scrolls the strip itself. `scrollIntoView` walks up and can move the
    // whole surface under the header to satisfy a nudge inside the bar.
    expect(strip).not.toContain("scrollIntoView");
  });

  test("an edge that hides a place says so, on every strip that scrolls", async () => {
    // A hidden scrollbar plus cells that refuse to shrink means a narrow bar
    // shows one cell and presents it as the whole set — the other places are
    // not merely offscreen, they are unannounced and unreachable with a mouse.
    // Both strips that scroll therefore carry the arrows, and they carry the
    // SAME ones: this defect was found on Tasks, fixed there, and then found
    // again unfixed in the conversation header a day later.
    for (const file of [
      "components/ui/tabs.tsx",
      "components/team/presentation/ConversationView.tsx",
    ]) {
      const src = await readSrc(file);
      expect(src).toContain("useStripOverflow");
      expect(src).toContain("<StripArrows");
      expect(src).toContain("ade-strip-wrap");
    }
    // The arrow is announceable rather than `aria-hidden`: assistive pointers
    // and anything driving the app read the tree, and an unlabelled div is
    // nothing to them — the same unreachable place, one layer down.
    const strip = await readSrc("components/ui/stripOverflow.tsx");
    expect(strip).toContain("aria-label={`Show more ${noun}`}");
    // Out of the tab ORDER though: Left/Right are how a keyboard walks a strip.
    expect(strip).toContain("tabIndex={-1}");
    // The fade dissolves into whatever ground the bar actually has. A fixed
    // colour paints a slab over any header that isn't a surface's.
    expect(CSS).toContain("var(--strip-fade, var(--color-bg-content))");
    expect(CSS).toContain("--strip-fade: var(--color-bg-0)");
  });
});
