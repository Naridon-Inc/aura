// A remote is read before a token is typed, not after the push fails.
//
// The three public forges each want a different username alongside a token, and
// a self-hosted one wants the person's own account name. Getting it wrong is a
// `401` that reads like a bad token — so this side asks rather than assuming,
// and what it says out loud is checked here.

import { describe, expect, mock, test } from "bun:test";

import type { ForgeAdvice } from "./forge";

function advice(over: Partial<ForgeAdvice> = {}): ForgeAdvice {
  return {
    remote: "https://github.com/Uniskool/naridon.git",
    host: "github.com",
    forge: "github",
    label: "GitHub",
    git_user: "x-access-token",
    needs_account_name: false,
    suggested_name: "GITHUB_TOKEN",
    plaintext: false,
    ssh: false,
    ...over,
  };
}

const gitlab = advice({
  remote: "https://gitlab.com/acme/app.git",
  host: "gitlab.com",
  forge: "gitlab",
  label: "GitLab",
  git_user: "oauth2",
  suggested_name: "GITLAB_TOKEN",
});

const bitbucket = advice({
  remote: "https://bitbucket.org/acme/app.git",
  host: "bitbucket.org",
  forge: "bitbucket",
  label: "Bitbucket",
  git_user: "x-token-auth",
  suggested_name: "BITBUCKET_TOKEN",
});

const selfHosted = advice({
  remote: "https://git.acme.internal/acme/app.git",
  host: "git.acme.internal",
  forge: "unknown",
  label: "a self-hosted git server",
  git_user: undefined,
  needs_account_name: true,
  suggested_name: "GIT_TOKEN",
});

const asked: string[] = [];

mock.module("../api", () => ({
  api: {
    placeGitForge: async (remote: string) => {
      asked.push(remote);
      if (remote.includes("gitlab")) return gitlab;
      if (remote.includes("bitbucket")) return bitbucket;
      if (remote.includes("acme.internal")) return selfHosted;
      return advice({ remote });
    },
  },
}));

const { askForge, canHoldCredential, forgeSentence } = await import("./forge");

describe("what this side knows about a remote", () => {
  test("the username table is the backend's and is asked for, never copied", async () => {
    // A copy here would agree with `place_forge` right up until one of the
    // forges changed its mind, and the symptom would be a 401 on a token the
    // member added correctly. So the module holds no table at all.
    const surface = await import("./forge");
    for (const [, exported] of Object.entries(surface)) {
      expect(typeof exported).toBe("function");
    }
    const source = await Bun.file(`${import.meta.dir}/forge.ts`).text();
    for (const spelling of ["oauth2", "x-token-auth"]) {
      expect(source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")).not.toContain(spelling);
    }
  });

  test("each of the three public forges comes back with its own username", async () => {
    expect((await askForge("https://gitlab.com/acme/app.git")).git_user).toBe("oauth2");
    expect((await askForge("https://bitbucket.org/acme/app.git")).git_user).toBe("x-token-auth");
    expect((await askForge("https://github.com/a/b.git")).git_user).toBe("x-access-token");
    expect(asked).toHaveLength(3);
  });
});

describe("what a surface says before a token is typed", () => {
  test("a forge that fixes the username fills it in rather than asking", () => {
    expect(forgeSentence(gitlab)).toContain("sends a token as oauth2");
    expect(forgeSentence(gitlab)).toContain("GitLab");
    expect(forgeSentence(bitbucket)).toContain("x-token-auth");
    expect(canHoldCredential(gitlab)).toBe(true);
  });

  test("a self-hosted forge is told it signs the person in as themselves", () => {
    // There is nothing to infer — the server authenticates the account, so the
    // sentence has to say so rather than quietly using GitHub's spelling.
    const said = forgeSentence(selfHosted);
    expect(said).toContain("your own account name");
    expect(said).not.toContain("x-access-token");
    expect(selfHosted.needs_account_name).toBe(true);
  });

  test("an ssh remote is told a token is not what it spends", () => {
    const said = forgeSentence(advice({ remote: "git@github.com:a/b.git", ssh: true }));
    expect(said).toContain("ssh key");
    expect(canHoldCredential(advice({ ssh: true }))).toBe(false);
  });

  test("an http remote is told why its own token will not be spent there", () => {
    // The box's own credential may still answer for it — its operator made that
    // choice. Spending a token somebody handed Aura is not Aura's to make.
    const said = forgeSentence(
      advice({ remote: "http://git.acme.internal/a/b.git", host: "git.acme.internal", plaintext: true }),
    );
    expect(said).toContain("unencrypted");
    expect(canHoldCredential(advice({ plaintext: true }))).toBe(false);
  });
});
