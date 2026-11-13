// Run with: bun test src/components/chat/model/setUpAgent.test.ts
//
// The Aura chat offers the models of the agents and keys that are set up, and
// with none set up it says so and opens the page that fixes it — never an
// empty or broken picker, and never a brain of Aura's own standing in.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");
const picker = read("ManagerModelPicker.tsx");
const button = read("SetUpAgentButton.tsx");

describe("the Aura chat's model picker with nothing set up", () => {
  test("offers only brains that can run", () => {
    expect(picker).toMatch(/brains\.filter\(\(b\) => !isUnusable\(b\)\)/);
    expect(picker).toMatch(/catalogOptions\(\{\s*brains: usable,/);
  });

  test("shows the set-up button once the list has loaded empty", () => {
    // A chat on one of the org's machines always has its machine's agent.
    expect(picker).toMatch(/const empty = !machine && loaded && usable\.length === 0;/);
    expect(picker).toMatch(/if \(empty\)[\s\S]{0,160}<SetUpAgentButton/);
  });

  test("the button is the outline small button, and opens Settings → Agents", () => {
    expect(button).toMatch(/variant="outline"/);
    expect(button).toMatch(/size="sm"/);
    expect(button).toContain("Set up an agent");
    expect(button).toMatch(/openModelSettings\("agents"\)/);
  });

  test("Auto is never named after Aura itself", () => {
    expect(picker).not.toMatch(/\?\? "Aura"/);
  });
});
