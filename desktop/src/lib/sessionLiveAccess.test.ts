// What a share actually hands someone.
//
// Three separate places decide whether a guest can work in a shared session:
// the level the share panel starts on, the rule the file pane reads, and the
// rule `aura-cloud/src/session_live/files.rs` enforces on the wire. The first
// two live in this repo and are checked here. The third is checked on its own
// side — but the sentence below is the one that keeps all three honest, so it
// is worth saying out loud: **file reads require `drive`.**
//
// The bug these tests exist to catch is quiet. Flip the share default back to
// `watch` and nothing breaks, nothing throws, no type changes: a host clicks
// Share, hands over a link, and their teammate gets a Files pane that answers
// "You are watching this session." The host has no reason to suspect the click
// did half a job. So the coupling is asserted rather than left to be noticed.

import { describe, expect, test } from "bun:test";

import {
  ACCESS_LEVELS,
  ACCESS_META,
  SHARE_DEFAULT_ACCESS,
} from "../components/collab/share/shareTypes";
import { canReadHostFiles } from "./sessionLiveSelectors";

describe("reading the host's project", () => {
  test("drive may, watch may not", () => {
    expect(canReadHostFiles("drive")).toBe(true);
    expect(canReadHostFiles("watch")).toBe(false);
  });

  test("every level the UI offers has an answer", () => {
    // A third level added to the menu without a decision here would default to
    // "cannot read" by falling off the `=== "drive"` comparison — silently,
    // and on the safe side, but silently. This fails first instead.
    for (const level of ACCESS_LEVELS) {
      expect(typeof canReadHostFiles(level)).toBe("boolean");
    }
  });
});

describe("what one click shares", () => {
  test("the default level can open the project", () => {
    // The whole point of the shared session: click Share once, and the person
    // who joins can read the code being worked on. If this fails, the first
    // click stopped handing over a workplace and started handing over a window.
    expect(canReadHostFiles(SHARE_DEFAULT_ACCESS)).toBe(true);
  });

  test("the default is a level the host can actually be shown", () => {
    expect(ACCESS_LEVELS).toContain(SHARE_DEFAULT_ACCESS);
    expect(ACCESS_META[SHARE_DEFAULT_ACCESS]).toBeDefined();
  });
});

describe("what the host is told they are giving away", () => {
  // Copy, asserted, because this is the one place a person finds out that
  // `drive` reaches their disk. A rewrite that drops the file half leaves the
  // host believing they granted a chat seat.
  test("drive says it reaches the files", () => {
    expect(ACCESS_META.drive.hostBlurb.toLowerCase()).toContain("files");
    expect(ACCESS_META.drive.guestBlurb.toLowerCase()).toContain("project");
  });

  test("watch says it does not", () => {
    expect(ACCESS_META.watch.hostBlurb.toLowerCase()).toContain("files");
    expect(ACCESS_META.watch.hostBlurb.toLowerCase()).toContain("can't open");
  });
});
