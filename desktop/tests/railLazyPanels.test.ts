// The right rail must not mount the sections you never opened.
//
// `hidden` is a paint instruction, not a lifecycle one. When every body
// rendered and merely wore the class, opening a project mounted all five
// panels at once — the file tree's directory reads, git status, the checks
// fetch, and a 15-second team-roster poll for a Commons lounge nobody had
// clicked. The rail felt slow for the same reason a page with five hidden
// tabs' worth of network is slow.
//
// This regresses invisibly: add a sixth panel, forget the guard, and the app
// still looks correct — the tab shows the right thing when clicked. The only
// evidence is a fetch nobody asked for. So the scan is structural: every body
// that switches on `activeTab` must also be gated on having been opened.

import { describe, expect, it } from "bun:test";

import { readSrc } from "./support/code";

const src = await readSrc("components/rightrail/RightRail.tsx");

/** Tab ids whose body is rendered with the `activeTab === "x" ? … : hidden`
 *  pattern — i.e. every section the rail can show. */
const bodyTabs = [...src.matchAll(/activeTab === "([a-z]+)" \?/g)].map((m) => m[1]);

describe("the rail's section bodies", () => {
  it("has bodies to check in the first place", () => {
    // A scan that finds nothing passes every other assertion below it, so pin
    // the sections we know the rail carries.
    expect(bodyTabs).toContain("files");
    expect(bodyTabs).toContain("changes");
    expect(bodyTabs).toContain("checks");
    expect(bodyTabs).toContain("commons");
    expect(bodyTabs).toContain("scribble");
  });

  it("gates every one on having been opened", () => {
    const ungated = bodyTabs.filter((tab) => !src.includes(`opened("${tab}")`));
    expect(ungated).toEqual([]);
  });

  it("gates plugin panels too. A plugin panel is someone else's code", () => {
    expect(src).toMatch(/pluginPanels[\s\S]{0,80}\.filter\(\(p\) => opened\(p\.id\)\)/);
  });

  it("remembers what was opened rather than unmounting on every switch", () => {
    // Once-seen-stays: unmounting the inactive section would throw away scroll
    // position and whatever is typed in Scribble.
    expect(src).toContain("seen.current.add(activeTab)");
    expect(src).toContain('const opened = (tab: RightRailTab) => seen.current.has(tab)');
    // The bodies keep their hidden/visible switch, so nothing re-fetches on a
    // return visit.
    expect(src).toContain('"hidden"');
  });
});
