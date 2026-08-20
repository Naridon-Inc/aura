// Local & custom models says what you get, and stops calling it a profile.
//
//   bun test
//
// Driven in a real window, Settings > Personal > Local & custom models read:
//
//     Local & custom models
//     OpenAI-compatible endpoints. Ollama, HuggingFace, Together, Groq,
//     OpenRouter, vLLM, anything that speaks /v1/chat/completions.
//
//     No profiles yet. Add one to chat with…        [ + Add profile ]
//
// The intro names the wire protocol twice and never says why anyone would
// come here. The empty state is one grey sentence with a button beside it —
// the only pane left without the real EmptyState every other surface got.
//
// And "profile" is already taken. Two rails up, Accounts & profiles means a
// git identity and an agent HOME by it; the launcher's "Profile" picker
// means that one too. A settings surface cannot spend one word on two
// unrelated things, so the thing you add here is a model.

import { describe, expect, test } from "bun:test";

import { readSrc, stripComments } from "./support/code";

const PANE = "components/settings/LocalModelsTab.tsx";

describe("local & custom models", () => {
  test("the word profile does not reach the screen", async () => {
    const src = await readSrc(PANE);
    for (const shown of [
      "No profiles yet",
      "+ Add profile",
      "Add profile",
      "profiles configured",
      "New local-model profile",
      "A profile with this name already exists",
    ]) {
      expect(src).not.toContain(shown);
    }
    // The type and the on-disk shape keep their name — only the copy changed.
    expect(src).toContain("OpenAiCompatProfile");
  });

  test("it is called a model, in every place you can press", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("+ Add a model");
    expect(src).toContain("Add a model");
    expect(src).toContain("Add model");
    expect(src).toContain("No models added yet");
  });

  test("the empty state is the real one, with a way out of it", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("EmptyState");
    expect(src).toContain("action={{");
  });

  test("the intro leads with what you get, not the wire path", async () => {
    const src = await readSrc(PANE);
    const intro = src.slice(src.indexOf("<PaneIntro"), src.indexOf("{loadError"));
    expect(intro).toContain("running on this machine");
    expect(intro).not.toContain("/v1/chat/completions");
  });

  test("the key warning states the consequence, not the release plan", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("anyone who can read that file can read the key");
    expect(src).not.toContain("for this iteration");
    expect(src).not.toContain("in a\n              follow-up");
  });

  test("the key warning is actually painted as a warning", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("text-amber");
    // There is no `accent-amber` token; the classes silently resolved to
    // nothing and the box read as body copy.
    expect(src).not.toContain("accent-amber");
  });
});

describe("the amber token is spelled one way", () => {
  // A colour class naming a token that doesn't exist fails silently: nothing
  // renders wrong, it renders unstyled, and a warning quietly stops looking
  // like a warning. Cheap to guard, expensive to notice by eye.
  test("the stylesheet defines amber and not accent-amber", async () => {
    const css = await readSrc("styles.css");
    expect(css).toContain("--color-amber:");
    expect(css).not.toContain("--color-accent-amber:");
  });

  test("no component reaches for the token that doesn't exist", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = `${import.meta.dir}/../src`;
    const offenders: string[] = [];
    for await (const rel of glob.scan(root)) {
      const src = await Bun.file(`${root}/${rel}`).text();
      if (/\baccent-amber\b/.test(stripComments(src))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
