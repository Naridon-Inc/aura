// A secret reaches the work and never reaches the screen.
//
// The invariant is one sentence: a model cannot echo a secret it never saw.
// This side's share of it is smaller than the backend's and worth stating
// anyway — the types carry no value field, the calls go through the one seam
// that knows both place-modes, and the sentences a surface shows are built from
// names and fingerprints rather than from anything spendable.

import { describe, expect, mock, test } from "bun:test";

import type { Machine } from "../api";
import { placeHere, placeOfMachine } from "./contract";
import type { SecretBoot, SecretRef } from "./secrets";

function box(over: Partial<Machine> = {}): Machine {
  return {
    id: "ubuntu@10.0.0.1",
    name: "aura-runner",
    host: "10.0.0.1",
    user: "ubuntu",
    key_path: "/keys/aura.pem",
    box_kind: "mine",
    repo_path: "/home/ubuntu/aura-src",
    project_root: "/home/mo/naridon",
    repo_branch: null,
    added_at: 1,
    last_used_at: 2,
    ...over,
  };
}

function ref(over: Partial<SecretRef> = {}): SecretRef {
  return {
    name: "GITHUB_TOKEN",
    added_at: 1_700_000_000,
    git_host: "github.com",
    git_user: "x-access-token",
    git_forge: "github",
    fingerprint: "3a7f0c11",
    ...over,
  };
}

function boot(over: Partial<SecretBoot> = {}): SecretBoot {
  return {
    place: "aura-runner",
    member: "mo",
    names: ["GITHUB_TOKEN"],
    installed: true,
    at: "~/.config/aura/env/p-0123456789abcdef.env",
    preload:
      "set -a; . \"$HOME\"/'.config/aura/env/p-0123456789abcdef.env' 2>/dev/null || true; set +a; ",
    ...over,
  };
}

// Every call the seam made, in the order it made them.
const listed: Array<{ root: string; member?: string }> = [];
const kept: Array<{
  root: string;
  name: string;
  value: string;
  opts?: { member?: string; gitHost?: string; gitUser?: string; gitForge?: string };
}> = [];
const forgotten: Array<{ root: string; name: string; member?: string }> = [];
const booted: Array<{
  place: { root: string | null; machineId: string | null };
  member?: string;
}> = [];

mock.module("../api", () => ({
  api: {
    placeSecretList: async (root: string, member?: string) => {
      listed.push({ root, member });
      return [ref()];
    },
    placeSecretPut: async (
      root: string,
      name: string,
      value: string,
      opts?: { member?: string; gitHost?: string; gitUser?: string; gitForge?: string },
    ) => {
      kept.push({ root, name, value, opts });
      return [ref({ name })];
    },
    placeSecretForget: async (root: string, name: string, member?: string) => {
      forgotten.push({ root, name, member });
      return [];
    },
    placeSecretBoot: async (
      place: { root: string | null; machineId: string | null },
      member?: string,
    ) => {
      booted.push({ place, member });
      return boot({ installed: place.machineId !== null });
    },
  },
}));

const {
  bootSecrets,
  bootSentence,
  forgetSecret,
  isCredentialFor,
  keepSecret,
  listSecrets,
  secretSentence,
} = await import("./secrets");

describe("what crosses to this side", () => {
  test("a secret has no value field, redacted or otherwise", async () => {
    const [held] = await listSecrets("/home/mo/naridon");
    // Not `expect(held.value).toBeUndefined()` — the point is that no key on
    // this object could hold one, including one a later edit adds.
    expect(Object.keys(held).sort()).toEqual([
      "added_at",
      "fingerprint",
      "git_forge",
      "git_host",
      "git_user",
      "name",
    ]);
  });

  test("a value goes in and there is no call that reads one back", async () => {
    await keepSecret("/home/mo/naridon", "GITHUB_TOKEN", "ghp_not_for_the_screen", {
      gitHost: "github.com",
    });
    expect(kept.at(-1)?.value).toBe("ghp_not_for_the_screen");
    // The answer to putting one in is the list, which holds none of them.
    const back = await keepSecret("/home/mo/naridon", "GITHUB_TOKEN", "ghp_x");
    expect(JSON.stringify(back)).not.toContain("ghp_");
    const surface = await import("./secrets");
    expect(Object.keys(surface).some((k) => /reveal|value|show/i.test(k))).toBe(false);
  });
});

describe("scope", () => {
  test("the vault is asked about a project on this laptop, never about a box", async () => {
    // Asking a box what a member holds would be asking the wrong computer, and
    // asking it over ssh would be sending the secrets there to find out.
    await listSecrets("/home/mo/naridon", "mo");
    expect(listed.at(-1)).toEqual({ root: "/home/mo/naridon", member: "mo" });
    await forgetSecret("/home/mo/naridon", "GITHUB_TOKEN");
    expect(forgotten.at(-1)).toEqual({
      root: "/home/mo/naridon",
      name: "GITHUB_TOKEN",
      member: undefined,
    });
  });

  test("both place-modes boot through the same call", async () => {
    // The governing rule of the programme: no feature lands in one mode only.
    const here = await bootSecrets(placeHere("/home/mo/naridon"));
    expect(booted.at(-1)?.place).toEqual({
      root: "/home/mo/naridon",
      machineId: null,
    });
    expect(here.installed).toBe(false);

    const there = await bootSecrets(placeOfMachine(box()));
    expect(booted.at(-1)?.place.machineId).toBe("ubuntu@10.0.0.1");
    expect(there.installed).toBe(true);
  });
});

describe("what a surface says", () => {
  test("a secret is described by where it goes, not by what it is", () => {
    expect(secretSentence(ref())).toBe(
      "GITHUB_TOKEN (3a7f0c11…) — pushes to github.com as x-access-token.",
    );
    // Without a host it is just a variable the work is started with, and
    // calling it a credential would be a claim about a push that isn't true.
    const said = secretSentence(
      ref({ git_host: undefined, git_user: undefined, git_forge: undefined, name: "OPENAI_API_KEY" }),
    );
    expect(said).toContain("in the environment of work you start");
    expect(said).not.toContain("pushes");
  });

  test("each service is described with the username it actually wants", () => {
    // The remotes the GitHub App cannot reach, which is the entire reason a
    // member's own token is held at all. Each wants a different username, and a
    // sentence that says `x-access-token` for all of them is telling somebody
    // something that is about to fail.
    const gitlab = ref({
      name: "GITLAB_TOKEN",
      git_host: "gitlab.com",
      git_user: "oauth2",
      git_forge: "gitlab",
    });
    expect(secretSentence(gitlab)).toContain("pushes to gitlab.com as oauth2");

    const bitbucket = ref({
      name: "BITBUCKET_TOKEN",
      git_host: "bitbucket.org",
      git_user: "x-token-auth",
      git_forge: "bitbucket",
    });
    expect(secretSentence(bitbucket)).toContain("as x-token-auth");

    // A self-hosted forge signs the person in as themselves.
    const own = ref({
      name: "GIT_TOKEN",
      git_host: "git.acme.internal",
      git_user: "mo",
      git_forge: "gitea",
    });
    expect(secretSentence(own)).toContain("pushes to git.acme.internal as mo");

    for (const held of [gitlab, bitbucket, own]) {
      expect(secretSentence(held)).not.toContain("x-access-token");
    }
  });

  test("a credential kept before services were recorded claims no username", () => {
    // An older vault has a host and nothing else. Filling in GitHub's spelling
    // here would be this surface inventing the one field that decides whether
    // the push works.
    const said = secretSentence(
      ref({ name: "GITLAB_TOKEN", git_host: "gitlab.com", git_user: undefined, git_forge: undefined }),
    );
    expect(said).toBe("GITLAB_TOKEN (3a7f0c11…) — pushes to gitlab.com.");
  });

  test("a credential can be kept for a service a hostname cannot be read for", async () => {
    // `git.acme.internal` says nothing about what runs there, so the service
    // and the account name are passed rather than guessed at either end.
    await keepSecret("/home/mo/naridon", "GIT_TOKEN", "gto_not_for_the_screen", {
      gitHost: "git.acme.internal",
      gitForge: "gitea",
      gitUser: "mo",
    });
    expect(kept.at(-1)?.opts).toEqual({
      gitHost: "git.acme.internal",
      gitForge: "gitea",
      gitUser: "mo",
    });
  });

  test("the boot line names variables and a path, and nothing spendable", () => {
    const said = bootSentence(boot());
    expect(said).toContain("GITHUB_TOKEN");
    expect(said).toContain("aura-runner");
    expect(said).toContain(".config/aura/env/");
  });

  test("this laptop is told the truth rather than a box's sentence", () => {
    // Nothing is written here because a process is handed its environment
    // directly. That is an answer, not a lesser outcome.
    const said = bootSentence(boot({ place: "this laptop", installed: false, at: undefined }));
    expect(said).toContain("this laptop");
    expect(said).not.toContain("loaded there from");
  });

  test("holding nothing is a sentence rather than an empty line", () => {
    expect(bootSentence(boot({ names: [] }))).toContain("has nothing kept for this project");
  });
});

describe("isCredentialFor", () => {
  test("matches a host regardless of case, and only that host", () => {
    expect(isCredentialFor(ref(), "GitHub.com")).toBe(true);
    expect(isCredentialFor(ref(), " github.com ")).toBe(true);
    // A GitLab token answering a GitHub push is a credential spent on the
    // wrong service.
    expect(isCredentialFor(ref({ git_host: "gitlab.com" }), "github.com")).toBe(false);
    expect(isCredentialFor(ref({ git_host: undefined }), "github.com")).toBe(false);
  });
});
