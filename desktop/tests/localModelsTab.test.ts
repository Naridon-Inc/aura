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
// come here, and the empty state never said what you would get.
//
// And "profile" is already taken. Two rails up, Accounts & profiles means a
// git identity and an agent HOME by it; the launcher's "Profile" picker
// means that one too. A settings surface cannot spend one word on two
// unrelated things, so the thing you add here is a model.

import { describe, expect, test } from "bun:test";

import { readSrc, strippedSrcTree } from "./support/code";

const PANE = "components/settings/LocalModelsTab.tsx";
const EDITOR = "components/settings/local-models/LocalModelEditor.tsx";

describe("local & custom models", () => {
  test("the word profile does not reach the screen", async () => {
    const src = (await readSrc(PANE)) + (await readSrc(EDITOR));
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
    const pane = await readSrc(PANE);
    const editor = await readSrc(EDITOR);
    expect(pane).toContain("Add a model");
    expect(editor).toContain("Add a model");
    expect(editor).toContain("Add model");
    expect(pane).toContain("No models added yet");
  });

  test("the empty state says what you get, with a way out of it", async () => {
    const src = await readSrc(PANE);
    const empty = src.slice(src.indexOf("<SettingsEmpty>"), src.indexOf("</SettingsEmpty>"));
    expect(empty).toContain("No models added yet");
    expect(empty).toContain("“+” menu");
    // The way out is always on the page, not only once something is added.
    const add = src.slice(src.indexOf('title="Add a model"'));
    expect(add).toContain("setEditing(blankOpenAiCompatProfile())");
  });

  test("the intro leads with what you get, not the wire path", async () => {
    const src = await readSrc(PANE);
    const intro = src.slice(src.indexOf("<SettingsIntro"), src.indexOf("{loadError"));
    expect(intro).toContain("running on this machine");
    expect(intro).not.toContain("/v1/chat/completions");
  });

  test("the key warning states the consequence, not the release plan", async () => {
    const src = await readSrc(EDITOR);
    expect(src).toContain("anyone who can read that file can read the key");
    expect(src).not.toContain("for this iteration");
    expect(src).not.toContain("in a follow-up");
  });

  test("the key warning sits on the key row, where the key is typed", async () => {
    const src = await readSrc(EDITOR);
    const keyRow = src.slice(src.indexOf('"API key"'), src.indexOf('id="local-model-key"'));
    expect(keyRow).toContain("saved unencrypted");
    expect(keyRow).toContain("~/.aura/agents/openai-compat.json");
    // There is no `accent-amber` token; a class naming it resolves to
    // nothing and the warning reads as body copy.
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
    const offenders: string[] = [];
    for (const [rel, src] of await strippedSrcTree()) {
      if (/\baccent-amber\b/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
