// Closing a tab has to actually close it — and stop what was in it.
//
//   bun test
//
// Two failures with the same shape: the close path pruned SOME of what the
// tab owned and left the rest, so the tab was gone from the strip while the
// thing it stood for carried on.
//
// 1. THE FILE OUTLIVED ITS OWN TAB. `closeTabInPane` reconciled the agent,
//    terminal and manager rosters against the split tree but not `files`,
//    and never cleared `activePath`. Files are the one kind with a SECOND
//    route to the screen: the flat file path in WorkSurface renders whatever
//    `activePath` names, layout or no layout. So closing the only tab pruned
//    the tree to null, the surface had no layout left to draw, and it fell
//    through to that route and drew the file again — no tab above it, and no
//    way back to the empty state short of switching project.
//
// 2. CLOSING A TERMINAL DIDN'T STOP THE JOB IN IT. Every close path called
//    `child.kill()`, which on unix is SIGKILL to the shell alone — the one
//    signal that cannot be caught, so the shell never got to hang up its
//    jobs. An interactive shell puts each job in its own process group, so a
//    dev server or watcher started in that tab was never signalled at all.
//    Measured before the fix: fork a shell on a pty, background a `sleep`,
//    SIGKILL the shell — the sleep survives, reparented to init. Hanging up
//    the process group instead kills it, which is what a terminal emulator
//    does when you close its window.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

describe("closing a file tab gives the surface back", () => {
  test("the file leaves the roster, not just the tree", async () => {
    const src = await readSrc("lib/editorStore.ts");
    expect(src).toMatch(
      /const files =\s*\n?\s*ref\.kind === "file" \? state\.files\.filter\(\(f\) => f\.path !== ref\.path\) : state\.files/,
    );
  });

  test("and stops being the active path, so the flat route can't redraw it", async () => {
    // This is the half that actually caused the report. Pruning `files`
    // without clearing `activePath` would leave the surface pointed at a
    // path it can no longer resolve.
    const src = await readSrc("lib/editorStore.ts");
    expect(src).toMatch(
      /ref\.kind === "file" && state\.activePath === ref\.path \? null : state\.activePath/,
    );
  });

  test("every exit from closeTabInPane carries both", async () => {
    // Three `setState` calls leave this function — layout emptied, one leaf
    // left, still a tree. A branch that forgets is the bug back for whichever
    // close shape reaches it.
    //
    // There was a fourth: the branch that collapsed a one-tab survivor back
    // onto the flat strip. It is gone, along with the strip it collapsed to —
    // see lastTabKeepsItsStrip.test.ts. That is why this count went down by
    // one, and why `activePath` has a single spelling here now.
    const src = await readSrc("lib/editorStore.ts");
    const body = src.slice(
      src.indexOf("function closeTabInPane"),
      src.indexOf("function closeOtherTabsInPane"),
    );
    expect(body.length).toBeGreaterThan(0);
    const exits = body.match(/setState\(\{/g) ?? [];
    expect(exits.length).toBe(3);
    expect((body.match(/\bfiles,/g) ?? []).length).toBe(3);
    expect((body.match(/\bactivePath,/g) ?? []).length).toBe(3);
  });
});

describe("closing a terminal stops what was running in it", () => {
  test("no close path SIGKILLs the child on its own any more", async () => {
    // `child.kill()` is the exact call that orphans the job.
    for (const rel of [
      "src-tauri/src/cmd_pty/mod.rs",
      "src-tauri/src/cmd_pty/registry.rs",
      "src-tauri/src/cmd_agent_pty.rs",
      "src-tauri/src/pty_daemon/server.rs",
    ]) {
      const src = await readSrc(`../${rel}`);
      expect(src).not.toContain("sess.child.lock().unwrap().kill()");
      expect(src).toContain("hangup_and_reap");
    }
  });

  test("the hangup goes to the GROUP. That is the whole point", async () => {
    // killpg, not kill: the shell's jobs are in their own process groups,
    // and reaching them is the difference between the fix and the bug.
    const src = await readSrc("../src-tauri/src/pty_reap.rs");
    expect(src).toContain("libc::killpg");
    expect(src).toContain("libc::SIGHUP");
    // SIGHUP first so a shell can forward it; SIGKILL only as the follow-up
    // for anything that trapped it.
    expect(src.indexOf("libc::SIGHUP")).toBeLessThan(src.indexOf("libc::SIGKILL"));
  });

  test("it refuses to hang up our own process group", async () => {
    // The catastrophic version of this bug: a terminal tab closing takes the
    // whole app down with it. Pinned as a Rust unit test too.
    const src = await readSrc("../src-tauri/src/pty_reap.rs");
    expect(src).toContain("libc::getpgrp()");
    expect(src).toMatch(/if pgid <= 1 \|\| pgid == own \{\s*\n\s*return false;/);
  });

  test("the follow-up kill doesn't make the click wait", async () => {
    // Closing a tab is a UI action; it can't block on a process deciding
    // how to die.
    const src = await readSrc("../src-tauri/src/pty_reap.rs");
    expect(src).toContain("std::thread::spawn");
  });
});
