// `/prototype` asks for a throwaway build in a scratch folder and a report.

import { describe, expect, test } from "bun:test";

import { PROTOTYPE_SCRATCH_DIR, buildPrototypePrompt } from "../src/lib/prototypePrompt";
import { readSrc } from "./support/code";

describe("buildPrototypePrompt", () => {
  test("names the topic when given one", () => {
    const p = buildPrototypePrompt("a dark mode toggle");
    expect(p).toContain("prototype of: a dark mode toggle");
  });

  test("still asks for a prototype with no topic", () => {
    expect(buildPrototypePrompt("   ")).toContain("what we are discussing");
  });

  test("keeps it in the scratch folder and asks for a report back", () => {
    const p = buildPrototypePrompt("x");
    expect(p).toContain(PROTOTYPE_SCRATCH_DIR);
    expect(p).toContain("Do not edit, move or delete any existing project file");
    expect(p).toMatch(/report back/i);
  });
});

describe("the command is reachable", () => {
  test("listed in the catalog, the chat menu, and handled by the chat", async () => {
    expect(await readSrc("lib/slashCommands.ts")).toContain('name: "/prototype"');
    expect(await readSrc("lib/managerCommands.ts")).toContain('name: "prototype"');
    expect(await readSrc("lib/chatSlashHandler.ts")).toContain('case "prototype"');
  });
});
