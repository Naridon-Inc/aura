// Restarting a Codex tab must return the conversation, not a blank REPL.
//
// The respawn paths in AgentSurface resolved a resume id for `claude` and
// `gemini` and fell through for everything else — so "Start agent" on a
// paused Codex tab spawned a bare `codex`, which is a NEW session. The CLI
// has supported `codex resume <uuid>` all along (aura-agents builds it), and
// the desktop simply never named a session to resume.
//
// The id has to be scoped to the tab's own directory: `~/.codex/sessions` is
// machine-wide, so "the most recent session" on a box driving several
// worktrees is routinely another project's.
//
// Scanned rather than rendered — the bug is which id the surface passes to
// `agent_pty_open`.

import { describe, expect, it } from "bun:test";

import { readSrc } from "./support/code";

const surface = await readSrc("components/agent/AgentSurface.tsx");
const apiSrc = await readSrc("lib/api.ts");

describe("a paused Codex tab that is started again", () => {
  it("resolves a resume id in both respawn paths", () => {
    const branches = surface.match(/t?a?b?\.agentId === "codex"/g) ?? [];
    // One in the mount-resume effect, one in the restart handler.
    expect(branches.length).toBeGreaterThanOrEqual(2);
    expect(surface).toContain("api.codexLatestSession(");
  });

  it("prefers the tab's own binding over a directory scan", () => {
    // A tab that already knows its conversation must not re-scan and risk
    // landing on a newer sibling session.
    expect(surface).toMatch(
      /resumeId = tab\.resumeSessionId \?\? undefined;\s*if \(!resumeId\) \{/,
    );
    expect(surface).toMatch(
      /resumeId = t\.resumeSessionId \?\? undefined;\s*if \(!resumeId\) \{/,
    );
  });

  it("binds the resolved id so the NEXT restart returns the same session", () => {
    const binds =
      surface.match(
        /\(\w+\.agentId === "claude" \|\| \w+\.agentId === "codex"\) && resumeId/g,
      ) ?? [];
    expect(binds.length).toBe(2);
  });

  it("asks the backend for a directory-scoped id, not the machine's newest", () => {
    expect(apiSrc).toMatch(
      /codexLatestSession: \(repoRoot: string\) =>\s*invoke<string \| null>\("codex_latest_session", \{ repoRoot \}\)/,
    );
  });
});
