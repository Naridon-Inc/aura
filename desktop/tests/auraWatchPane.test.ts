// Settings → Repository → Change reasons, driven in a real window.
//
//   bun test
//
// For the first moment this pane existed it asserted three false things and
// then quietly took them all back:
//
//     MODE     [ Off ]  [ Remind me ]  [ Fill it in for me ]     ← none marked
//     AI AVAILABLE TO FILL IN REASONS
//       ○ Ollama   ○ Anthropic key   ○ OpenAI key                ← no agents
//
//   …a beat later…
//
//     MODE     [ Off ]  [ Remind me ]  [ *Fill it in for me* ]
//       ✳ Claude Code · already installed · active
//       ✦ Gemini CLI   ⬡ Codex   ○ Ollama …
//
// The mode row was reading `status?.mode`, and `aurawatch_status` returns an
// Option — so until the call came back the answer was "none of these", on the
// one screen whose question is "is Aura watching?". The mode is also already
// on this machine: App reads `aura.aurawatch.mode` out of localStorage to
// decide whether to watch at all, so the round trip only confirms it.
//
// The list underneath is a claim about what's installed here, and it was
// making it before anything had been probed. Both reads sat under one
// `Promise.all(...).catch(() => {})`, so a failed probe threw the mode away
// too and left the pane looking loaded — a probe that never answered was
// drawn identically to a machine with nothing on it.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const PANE = "components/dialogs/AuraWatchSettingsDialog.tsx";

describe("change reasons — the pane doesn't answer before it knows", () => {
  test("the mode is seeded from the key App itself reads", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("function storedMode(): WatchMode");
    expect(src).toContain('localStorage.getItem("aura.aurawatch.mode")');
    // Same default as App's own fallback; disagreeing would make the switch
    // show one thing while the watcher does another.
    expect(src).toContain('    : "nudge";');
    expect(src).toContain("useState<WatchMode>(storedMode)");
  });

  test("selection reads the seeded mode, not the pending status", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("mode === m");
    expect(src).not.toContain("status?.mode === m");
  });

  test("status and detection fail independently", async () => {
    const src = await readSrc(PANE);
    // One catch over both reads meant a dead probe also cost the mode.
    expect(src).not.toContain("Promise.all([\n        api.aurawatchStatus");
    expect(src).toContain("const [detecting, setDetecting] = useState(true)");
    expect(src).toContain(
      "const [detectError, setDetectError] = useState<string | null>(null)",
    );
    expect(src).toContain("setDetectError(String(e?.message ?? e))");
    // An unmounted pane must not write state back — this effect re-runs on
    // repo change and on retry.
    expect(src).toContain("alive = false;");
    expect(src).toContain("}, [repoRoot, attempt]);");
  });

  test("probing shows the app's one loader, not an empty list", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("{detecting ? (");
    expect(src).toContain("<LoadingState");
    expect(src).toContain("Looking for what's already on this machine…");
  });

  test("a failed probe says so, and can be asked again", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("<ErrorNote");
    expect(src).toContain("Aura couldn’t check what’s on this machine.");
    expect(src).toContain("setAttempt((n) => n + 1)");
    expect(src).toContain('import { ErrorNote, LoadingState } from "../ui/state"');
  });

  test("the switch moves under the finger, and goes back if it didn't take", async () => {
    const src = await readSrc(PANE);
    const fn = src.slice(
      src.indexOf("async function setMode("),
      src.indexOf("<PaneIntro"),
    );
    expect(fn).toContain("const previous = mode;");
    expect(fn).toContain("setModeState(next);");
    // The backend is still the authority once it answers.
    expect(fn).toContain("setModeState(s.mode);");
    expect(fn).toContain("setModeState(previous);");
    // App's footer chip and watch lifecycle key off this event's detail.
    expect(fn).toContain("detail: { mode: next }");
  });

  test("and the sentence about agent CLIs is a sentence", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("a coding agent you already have installed");
    expect(src).toContain("to write the reason for you");
  });
});
