import { describe, expect, test } from "bun:test";

import { makeRemoteRepoFor, parseOwnerRepo } from "./prRepo";

describe("parseOwnerRepo", () => {
  test("reads every spelling git writes for a GitHub origin", () => {
    for (const url of [
      "https://github.com/Naridon-Inc/aura.git",
      "https://github.com/Naridon-Inc/aura",
      "https://github.com/Naridon-Inc/aura/",
      "git@github.com:Naridon-Inc/aura.git",
      "git@github.com:Naridon-Inc/aura",
      "ssh://git@github.com/Naridon-Inc/aura.git",
      "ssh://github.com/Naridon-Inc/aura",
      "github.com/Naridon-Inc/aura",
      "  https://github.com/Naridon-Inc/aura.git\n",
    ]) {
      expect(parseOwnerRepo(url)).toBe("Naridon-Inc/aura");
    }
  });

  test("keeps a name that ends in .git-like text intact", () => {
    expect(parseOwnerRepo("https://github.com/o/my.gitops")).toBe("o/my.gitops");
    expect(parseOwnerRepo("https://github.com/o/my.gitops.git")).toBe("o/my.gitops");
  });

  test("is not fooled by a URL that is not a repo", () => {
    for (const url of [
      "",
      "   ",
      "https://github.com/Naridon-Inc",
      "https://github.com/Naridon-Inc/aura/tree/main",
      "https://github.com/",
      "not a url",
      "/Users/me/aura",
      "git@github.com:aura",
      "https://github.com/-flag/aura",
      "https://github.com/../aura",
    ]) {
      expect(parseOwnerRepo(url)).toBeNull();
    }
  });
});

describe("remoteRepoFor", () => {
  const BOX = "ubuntu@box:/home/ubuntu/aura";
  const HERE = "/Users/me/aura";

  function harness(opts: { onBox: boolean; origin: string }) {
    const asked: string[] = [];
    const { remoteRepoFor, forgetRemoteRepo } = makeRemoteRepoFor({
      machineIdForRoot: () => (opts.onBox ? BOX : null),
      gitRemoteOrigin: async (root) => {
        asked.push(root);
        return opts.origin;
      },
      placeScope: (root) => (opts.onBox ? `${BOX}\0${root}` : root),
    });
    return { remoteRepoFor, forgetRemoteRepo, asked };
  }

  test("a project on this laptop is null, and origin is never asked", async () => {
    const h = harness({ onBox: false, origin: "https://github.com/o/r" });
    expect(await h.remoteRepoFor(HERE)).toBeNull();
    expect(h.asked).toEqual([]);
  });

  test("a project on a machine names the repo its origin points at", async () => {
    const h = harness({ onBox: true, origin: "git@github.com:o/r.git" });
    expect(await h.remoteRepoFor(HERE)).toBe("o/r");
  });

  test("a resolved slug is remembered per place, and can be forgotten", async () => {
    const h = harness({ onBox: true, origin: "https://github.com/o/r" });
    await h.remoteRepoFor(HERE);
    await h.remoteRepoFor(HERE);
    expect(h.asked).toEqual([HERE]);
    h.forgetRemoteRepo(HERE);
    await h.remoteRepoFor(HERE);
    expect(h.asked).toEqual([HERE, HERE]);
  });

  test("a machine whose origin names no repo is an error, not a local run", async () => {
    const none = harness({ onBox: true, origin: "" });
    await expect(none.remoteRepoFor(HERE)).rejects.toThrow(/no origin/);
    const elsewhere = harness({ onBox: true, origin: "https://gitlab.example/only-owner" });
    await expect(elsewhere.remoteRepoFor(HERE)).rejects.toThrow(/isn't a GitHub repo/);
    // Nothing is remembered from a failure — the next ask is real.
    expect(none.asked).toEqual([HERE]);
    await none.remoteRepoFor(HERE).catch(() => null);
    expect(none.asked).toEqual([HERE, HERE]);
  });
});
