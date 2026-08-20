// What a clone URL should be called once it's on the box.
//
// Small, but it is the difference between someone pressing one button and
// someone typing their own repo's name a second time — and between a folder
// called `naridon` and one called `naridon.git`, which every later `cd` has to
// live with. The five spellings below are all things people genuinely paste.

import { describe, expect, test } from "bun:test";

import { repoFolderName } from "./BoxPanel";

describe("naming a project someone is putting on a machine", () => {
  test("an https clone url becomes the repo's own name", () => {
    expect(repoFolderName("https://github.com/you/naridon.git")).toBe("naridon");
  });

  test("the .git suffix is not part of the folder name", () => {
    // A directory called `naridon.git` reads as a bare repo to anyone who
    // later looks at the box, and it isn't one.
    expect(repoFolderName("https://github.com/you/naridon")).toBe("naridon");
    expect(repoFolderName("https://github.com/you/naridon.GIT")).toBe("naridon");
  });

  test("a trailing slash doesn't produce an empty name", () => {
    expect(repoFolderName("https://github.com/you/naridon/")).toBe("naridon");
  });

  test("the scp-style ssh spelling gets the same answer", () => {
    expect(repoFolderName("git@github.com:you/naridon.git")).toBe("naridon");
    // Pasted without the path, which is the half people copy off a README.
    expect(repoFolderName("git@github.com:naridon.git")).toBe("naridon");
  });

  test("nothing typed yet is nothing suggested, not a guess", () => {
    expect(repoFolderName("")).toBe("");
    expect(repoFolderName("   ")).toBe("");
  });
});
