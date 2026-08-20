// A page mention arrives as a DM containing an `aura://page/…` link, and the
// chat has to turn that string back into the page it names — a card you can
// read and a button that opens it.
//
// It didn't. Someone wrote a team Scribble, @-mentioned a colleague in it, and
// the colleague got a line of dead text they could not click, could not open,
// and could only retype into a search box. The reason is a shape nobody
// designed and everybody had to agree on anyway: a team page has no bucket, so
// the link it produces carries an empty middle segment, and the parser dropped
// empty segments before counting them. Two segments where three were required,
// and every team page — which is most of them — failed to resolve.
//
// The other half was the Copy-link button handing out the in-app composite key
// (`scope|bucket|id`) with `aura://page/` glued in front, which is a fourth
// spelling of the same page that nothing on either side can read.

import { describe, expect, it } from "bun:test";

import { parseAuraRef, pageRefUrl } from "../src/lib/auraRelay";
import { pageKey, parsePageKey } from "../src/components/pages2/pagesApi";

/** What `cmd_notes.rs` puts in a mention DM for a team page: no bucket. */
const TEAM_LINK = "aura://page/team//note_934b7291-7f84-448b-8cb3-7b0cb67ddac4";

describe("parsing the link a mention DM carries", () => {
  it("resolves a team page, whose bucket segment is empty", () => {
    expect(parseAuraRef(TEAM_LINK)).toEqual({
      kind: "page",
      scope: "team",
      bucket: "",
      id: "note_934b7291-7f84-448b-8cb3-7b0cb67ddac4",
    });
  });

  it("resolves a channel page, whose bucket is the channel id", () => {
    expect(parseAuraRef("aura://page/channel/general/note_1")).toEqual({
      kind: "page",
      scope: "channel",
      bucket: "general",
      id: "note_1",
    });
  });

  it("resolves a member page, whose bucket is the handle", () => {
    expect(parseAuraRef("aura://page/member/mhask/note_2")).toEqual({
      kind: "page",
      scope: "member",
      bucket: "mhask",
      id: "note_2",
    });
  });

  it("reads a hand-written two-segment link as the same page", () => {
    // Nobody types the empty segment. `aura://page/team/note_x` is what a
    // person writes when they mean a team page, and it names one thing.
    expect(parseAuraRef("aura://page/team/note_934b7291")).toEqual({
      kind: "page",
      scope: "team",
      bucket: "",
      id: "note_934b7291",
    });
  });

  it("still refuses a link that names no page", () => {
    expect(parseAuraRef("aura://page/team")).toBeNull();
    expect(parseAuraRef("aura://page/")).toBeNull();
  });
});

describe("the link Copy link puts on the clipboard", () => {
  it("round-trips through the parser", () => {
    const page = { scope: "team", bucket: "", id: "note_934b7291" };
    expect(parseAuraRef(pageRefUrl(page))).toEqual({ kind: "page", ...page });
  });

  it("is the same string the backend sends in a mention DM", () => {
    expect(
      pageRefUrl({
        scope: "team",
        bucket: "",
        id: "note_934b7291-7f84-448b-8cb3-7b0cb67ddac4",
      }),
    ).toBe(TEAM_LINK);
  });

  it("does not hand out the in-app composite key", () => {
    // `pageKey` is pipe-delimited and internal. Pasted after `aura://page/` it
    // produced a link that looked right and opened nothing.
    const key = pageKey({ scope: "team", bucket: "", id: "note_934b7291" });
    expect(parseAuraRef(`aura://page/${key}`)).toBeNull();
    const parsed = parsePageKey(key);
    expect(parsed).not.toBeNull();
    expect(parseAuraRef(pageRefUrl(parsed!))).not.toBeNull();
  });
});
