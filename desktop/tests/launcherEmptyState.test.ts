// The empty work surface, and the two things it was still getting wrong.
//
//   bun test
//
// 1. IT OFFERED TO START SOMEWHERE ELSE FROM INSIDE A WORKTREE. The launcher's
//    project target lists every known project, and a managed worktree is a
//    checkout the user deliberately isolated to hold ONE piece of work. Landing
//    in it and being asked which project to start in inverts the thing the
//    worktree is for; the pane's own root is the answer, and there is nothing
//    for the control to say.
//
// 2. "WHAT WAS I DOING HERE" WAS A PAGE YOU LEFT FOR. Everything the launcher
//    offered was something that exists right now — an agent on PATH, a tab open
//    somewhere, a session still running. The reader who lands on an empty
//    surface has as often come back to a repo they were mid-way through, and
//    the only answer for them was a footer link out to the Sessions page.
//
// The rows for both halves share one shape, one search box and one cursor —
// that is what these pins are mostly protecting. A second list with its own
// keyboard model is how "↑↓ then Enter" quietly stops working half way down a
// panel.

import { describe, expect, test } from "bun:test";

import { sessionPromptTitle } from "../src/lib/sessionPromptTitle";
import { readSrc } from "./support/code";

describe("what a past session is called", () => {
  test("the words the user typed", () => {
    expect(sessionPromptTitle("fix the retry backoff")).toBe(
      "fix the retry backoff",
    );
  });

  test("whitespace collapses. A row is one line", () => {
    expect(sessionPromptTitle("fix   the\n\nbackoff")).toBe("fix the backoff");
  });

  test("a scheduled wake-up says so instead of printing its XML", () => {
    // The failure this exists for: 200 characters of <task-notification> wins
    // any row it is put in, and tells the reader nothing about the session.
    const raw =
      "<task-notification><task-id>abc</task-id><summary>Agent finished the migration</summary></task-notification>";
    expect(sessionPromptTitle(raw)).toBe("↻ scheduled · Agent finished the migration");
  });

  test("agent dispatch, slash commands and reminders each get their own line", () => {
    expect(sessionPromptTitle("<task><description>audit the rail</description></task>")).toBe(
      "▶ task · audit the rail",
    );
    expect(sessionPromptTitle("<command-name>review</command-name>")).toBe("/ review");
    expect(sessionPromptTitle("<system-reminder>be brief</system-reminder>")).toBe(
      "(system reminder)",
    );
    expect(sessionPromptTitle("<<autonomous-loop-dynamic>>")).toBe("↻ autonomous loop");
  });

  test("nothing to say is an empty string, not a placeholder", () => {
    // Callers decide what an untitled session reads as — "empty session" and
    // "Untitled session" belong to different surfaces.
    expect(sessionPromptTitle("   ")).toBe("");
    expect(sessionPromptTitle(null)).toBe("");
    expect(sessionPromptTitle(undefined)).toBe("");
  });

  test("one copy of it. The resume dialog reads this one", async () => {
    const dialog = await readSrc("components/agent/ResumeDialog.tsx");
    expect(dialog).toContain("sessionPromptTitle");
    // Two wrapper-recognising functions is how one of them ends up recognising
    // a wrapper the other doesn't.
    expect(dialog).not.toContain("function cleanPrompt");
  });
});

describe("a worktree pane doesn't offer another project", () => {
  test("the target is gated on the root NOT being a managed worktree", async () => {
    const src = await readSrc("components/launcher/Launcher.tsx");
    expect(src).toContain("isManagedWorktreeRoot(currentRepoRoot)");
    expect(src).toMatch(/hasOtherProjects\s*=\s*\n?\s*!inWorktree/);
    // …and that flag is still what draws it.
    expect(src).toMatch(/hasOtherProjects && \(\s*<ProjectSpawnTarget/);
  });

  test("the spawn target follows the workspace it is mounted in", async () => {
    // The launcher outlives a project switch (the empty surface stays
    // mounted), so a target initialised once stayed pointed at the workspace
    // the reader LEFT and the next thing they started opened in it.
    const src = await readSrc("components/launcher/Launcher.tsx");
    expect(src).toMatch(
      /setSpawnRoot\(currentRepoRoot\);\s*\n\s*\}, \[currentRepoRoot\]\)/,
    );
  });
});

describe("start something new / earlier sessions", () => {
  test("the switch is the app's one segmented control, with both halves", async () => {
    const src = await readSrc("components/launcher/Launcher.tsx");
    expect(src).toContain("Segment<Mode>");
    expect(src).toContain('"Start something new"');
    expect(src).toContain("Earlier sessions");
  });

  test("only where a reader lands. The '+' popover keeps one list", async () => {
    const src = await readSrc("components/launcher/Launcher.tsx");
    expect(src).toContain('const canSwitch = variant === "compact"');
    // A host that can't switch is pinned to the live half; `showing` (not
    // `mode`) is what the body and the cursor read.
    expect(src).toContain('const showing: Mode = canSwitch ? mode : "now"');
  });

  test("one cursor over whatever is showing", async () => {
    // Enter must pick the row the reader can see, never one on the side they
    // switched away from.
    const src = await readSrc("components/launcher/Launcher.tsx");
    expect(src).toMatch(
      /showing === "earlier" \? shownEarlier : \[\.\.\.shownStarters, \.\.\.shownOpen\]/,
    );
    expect(src).toMatch(/setCursor\(0\);\s*\n\s*\}, \[q, showing\]\)/);
  });

  test("resuming spawns at the SESSION's cwd, not the workspace root", async () => {
    // Claude resolves `--resume <id>` by the directory it was launched in, so
    // a conversation authored in a sibling worktree spawned at the project
    // root comes back as an empty REPL with none of the transcript in it.
    const src = await readSrc("components/launcher/earlierSessions.tsx");
    expect(src).toContain("const cwd = resumeCwdOf(s, repoRoot)");
    expect(src).toMatch(/agentPtyOpen\(\s*"claude",\s*cwd,/);
    // The tab is bound to the conversation it reopened, so its own restarts
    // resume THIS thread rather than the repo's newest.
    expect(src).toContain("resumeSessionId: s.session_id");
  });

  test("the list is shared, not a sixteenth private walk of ~/.claude", async () => {
    const src = await readSrc("components/launcher/earlierSessions.tsx");
    expect(src).toContain("fetchSessions");
    expect(src).toContain("peekSessions");
    expect(src).not.toContain("api.claudeListSessions");
  });

  test("a failed read and an empty repo say different things", async () => {
    // Saying "nothing has run here" when the truth is we couldn't look is how
    // a reader concludes their work is gone.
    const src = await readSrc("components/launcher/earlierSessions.tsx");
    expect(src).toContain("Couldn");
    expect(src).toContain("Nothing has run here yet");
  });

  test("the list is THIS checkout's, not every sibling worktree's", async () => {
    // claude_list_sessions deliberately unions sibling worktrees and the
    // parent repo, so the raw list shown inside `marrakesh` is mostly
    // `auckland`'s work and the main checkout's — the wrong answer for a pane
    // that promises "what was I doing HERE".
    const src = await readSrc("components/launcher/earlierSessions.tsx");
    expect(src).toContain("isOwnWorktreeSession");
    expect(src).toMatch(
      /list\.filter\(\(s\) => isOwnWorktreeSession\(s, repoRoot\)\)/,
    );
  });

  test("the filter runs before the count, so the tab label agrees with the list", async () => {
    // `total` feeds the segment's "Earlier sessions · N". Counting the union
    // and listing the filtered set would promise rows that aren't there.
    const src = await readSrc("components/launcher/earlierSessions.tsx");
    expect(src).toMatch(/setSessions\(ownOnly\(list, repoRoot\)\)/);
    expect(src).toMatch(/setSessions\(ownOnly\(peekSessions\(repoRoot\), repoRoot\)\)/);
    // …and an unread cache still reads as unread, not as an empty worktree.
    expect(src).toContain("if (!list) return null");
  });

  test("nothing-read-yet and this-worktree-has-none stay distinguishable", async () => {
    const src = await readSrc("components/launcher/earlierSessions.tsx");
    expect(src).toContain("loading: sessions === null && !error");
  });
});

describe("one segmented control, and it is a track", () => {
  test("the track is the base row rule. Every strip in the app gets it", async () => {
    // `.ade-seg--row` is what `Segment` renders AND what the four raw-markup
    // surfaces write by hand (right rail, fleet lens, Team catch-up, board
    // layout switch), so putting the track here is what makes one change
    // reach all of them.
    const css = await readSrc("styles.css");
    expect(css).toMatch(
      /\.ade-seg--row \{[^}]*border: 1px solid var\(--color-line-soft\)/,
    );
    expect(css).toMatch(/\.ade-seg--row \{[^}]*background: var\(--color-bg-1\)/);
    // Cells are joined, not spaced — a gap would undo the set.
    expect(css).toMatch(/\.ade-seg--row \{[^}]*gap: 0/);
  });

  test("the active cell is raised in BOTH themes", async () => {
    // bg-3 is lighter than the track in dark and darker in light, which flips
    // raised to pressed when the theme changes. bg-0 sits above bg-1 in both.
    const css = await readSrc("styles.css");
    expect(css).toMatch(
      /\.ade-seg--row button\.active \{[^}]*background: var\(--color-bg-0\)/,
    );
    // …and "selected" still means the accent, as it does everywhere else.
    expect(css).toMatch(
      /\.ade-seg--row button\.active \{[^}]*color: var\(--color-accent\)/,
    );
  });

  test("one divider between cells, never doubled against the track", async () => {
    const css = await readSrc("styles.css");
    expect(css).toMatch(
      /\.ade-seg--row button:first-child \{\s*border-left: 0;/,
    );
  });

  test("no prop to choose the look with. That is the point", async () => {
    // A switch that reads as buttons in one place and links in another is the
    // thing this component exists to prevent.
    const seg = await readSrc("components/ui/segment.tsx");
    expect(seg).not.toContain("tone");
    expect(seg).not.toContain("ade-seg--clubbed");
    const css = await readSrc("styles.css");
    expect(css).not.toContain(".ade-seg--clubbed");
  });

  test("the floating capsule rounds the track, not the cells", async () => {
    // Two nested radii is what you get if the cells keep rounding once the
    // strip has a track of its own.
    const css = await readSrc("styles.css");
    expect(css).toMatch(/\.ade-seg--pill \{\s*border-radius: 999px;/);
    expect(css).not.toMatch(/\.ade-seg--pill button \{\s*border-radius: 999px;/);
  });

  test("the right rail is the one opt-out, and it says why", async () => {
    // The rail's cells re-flow — only the tab you are on spells its name — so
    // a bordered track around them reads as the control resizing under the
    // cursor, and its unread counts overhang the glyph the track would clip.
    // Both are structural, which is why this one strip gets `--bare` and
    // nothing else does.
    const rail = await readSrc("components/rightrail/RightRail.tsx");
    expect(rail).toContain("ade-seg--bare");
    const css = await readSrc("styles.css");
    expect(css).toMatch(/\.ade-seg--bare \{[^}]*border: 0/);
    expect(css).toMatch(/\.ade-seg--bare \{[^}]*background: transparent/);

    // …and every other hand-written strip stays on the track.
    for (const rel of [
      "components/workspaces/WorkspacesSurface.tsx",
      "components/team/TeamSurface.tsx",
      "components/board/BoardLayoutSwitch.tsx",
      "components/ui/segment.tsx",
    ]) {
      expect(await readSrc(rel)).not.toContain("ade-seg--bare");
    }
  });

  test("the cap is stated, not silent", async () => {
    const src = await readSrc("components/launcher/earlierSessions.tsx");
    expect(src).toContain("most recent of");
  });

  test("the Aura tile opens a chat. It never asks the CLI registry for a binary", async () => {
    // The orchestrator runs in-process. `agent_pty_open` resolves ids against
    // the registry of agents installed on PATH, so the first tile in the
    // launcher answered every click with "unknown agent: aura-manager".
    const src = await readSrc("components/launcher/Launcher.tsx");
    const body = src.slice(
      src.indexOf("async function startAgent"),
      src.indexOf("function startLocalModel"),
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("MANAGER_AGENT.id");
    // Before the spawn, not after it.
    expect(body.indexOf("MANAGER_AGENT.id")).toBeLessThan(
      body.indexOf("api.agentPtyOpen"),
    );
    expect(src).toContain("api.managerChatStart(spawnRoot");
    expect(src).toContain('pick({ kind: "manager", id: sid })');
    // The peer it guards on is still the synthetic one — declared in the
    // module rather than returned by `agent_discover`'s PATH scan.
    const agents = await readSrc("lib/agents.ts");
    expect(agents).toMatch(/MANAGER_AGENT: Agent = \{[^}]*id: "aura-manager"/);
  });

  test("the empty state stopped drawing its own history link", async () => {
    // It is the switch now — one click nearer, with the sessions themselves
    // under it rather than a page you leave for.
    const src = await readSrc("components/workpanes/WorkSurfaceEmpty.tsx");
    expect(src).not.toContain("Earlier sessions");
    expect(src).not.toContain("openSessions");
  });
});
