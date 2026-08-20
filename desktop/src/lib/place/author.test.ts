import { describe, expect, mock, test } from "bun:test";

import type { AuthorPlan, Authorship, GitAuthor } from "./author";

const reached: Array<{
  call: string;
  root: string | null;
  machineId: string | null;
  name: string | null;
  email: string | null;
}> = [];
let answer: AuthorPlan | null = null;

mock.module("../api", () => ({
  api: {
    placeAuthor: (
      place: { root: string | null; machineId: string | null },
      member: GitAuthor | null,
    ) => {
      reached.push({
        call: "ask",
        ...place,
        name: member?.name ?? null,
        email: member?.email ?? null,
      });
      return Promise.resolve(answer);
    },
    placeAuthorAdopt: (
      place: { root: string | null; machineId: string | null },
      author: GitAuthor,
    ) => {
      reached.push({ call: "adopt", ...place, ...author });
      return Promise.resolve(answer);
    },
  },
}));

const {
  adoptAuthor,
  askAuthor,
  authorLine,
  authorTone,
  currentAuthor,
  needsAdopting,
  whyNotMe,
} = await import("./author");
const { placeHere, placeOfMachine } = await import("./contract");

const ME: GitAuthor = { name: "mo", email: "mo@users.noreply.auravcs.com" };
const ANA: GitAuthor = { name: "ana", email: "ana@users.noreply.auravcs.com" };
const RUNNER: GitAuthor = { name: "Aura Runner", email: "runner@auravcs.com" };

function plan(authorship: Authorship, over: Partial<AuthorPlan> = {}): AuthorPlan {
  return {
    place: "shed",
    root: "/srv/alpha",
    you: "ubuntu",
    member: ME,
    origin: "file:/srv/alpha/.git/config",
    adopted: false,
    note: "",
    authorship,
    ...over,
  };
}

describe("what a place says about whose name is on the commit", () => {
  test("my own name is the quiet answer, with nothing to offer", () => {
    const p = plan({ who: "mine", author: ME });
    expect(authorTone(p)).toBe("own");
    expect(needsAdopting(p)).toBe(false);
    // A button that changed nothing would be worse than no button.
    expect(whyNotMe(p)).toBe("");
    expect(currentAuthor(p)).toEqual(ME);
  });

  test("the box's own identity is amber and says what gave it away", () => {
    const p = plan({
      who: "machine",
      author: RUNNER,
      why: "this is the machine's own identity, set in file:/etc/gitconfig",
    });
    expect(authorTone(p)).toBe("machine");
    expect(needsAdopting(p)).toBe(true);
    expect(whyNotMe(p)).toContain("/etc/gitconfig");
    expect(currentAuthor(p)).toEqual(RUNNER);
  });

  test("a teammate is a person, not the machine — a different next step", () => {
    const p = plan({ who: "someone", author: ANA });
    // Overwriting unasked would be the wrong move here, so it must not be
    // rendered as the same problem as the box's identity.
    expect(authorTone(p)).toBe("someone");
    expect(authorTone(p)).not.toBe("machine");
    expect(whyNotMe(p)).toContain("somebody else");
    expect(whyNotMe(p)).toContain(ANA.email);
  });

  test("nothing set is an answer with a reason, not a failure", () => {
    const p = plan({
      who: "missing",
      why: "git has no name or email here, so a commit would be refused",
    });
    expect(authorTone(p)).toBe("none");
    expect(currentAuthor(p)).toBeNull();
    expect(whyNotMe(p)).toContain("refused");
  });

  test("signed out, there is nothing to adopt however wrong the author is", () => {
    const p = plan({ who: "machine", author: RUNNER, why: "the machine" }, {
      member: null,
    });
    expect(needsAdopting(p)).toBe(false);
  });

  test("an author renders the way git renders it", () => {
    expect(authorLine(ME)).toBe("mo <mo@users.noreply.auravcs.com>");
  });
});

describe("asking a place rather than a repo root", () => {
  test("this laptop is asked as a place, with the account's identity", async () => {
    reached.length = 0;
    answer = plan({ who: "mine", author: ME });
    await askAuthor(placeHere("/Users/me/alpha"), ME);
    expect(reached).toHaveLength(1);
    expect(reached[0]).toMatchObject({
      call: "ask",
      root: "/Users/me/alpha",
      machineId: null,
      name: "mo",
    });
  });

  test("a box is asked through the same call, and is the one asked", async () => {
    reached.length = 0;
    answer = plan({ who: "machine", author: RUNNER, why: "the machine" });
    const box = placeOfMachine({
      id: "m-1",
      name: "shed",
      host: "10.0.0.4",
      user: "ubuntu",
      key_path: "/Users/me/.ssh/id_ed25519",
      box_kind: "shared",
      repo_path: "/srv/alpha",
      project_root: "/Users/me/alpha",
      repo_branch: null,
      added_at: 1,
      last_used_at: 2,
    });
    await askAuthor(box, ME);
    // The whole point: the SAME function, and the box is the target rather than
    // this laptop. A feature that reached only one of these is the failure the
    // Place seam exists to make impossible.
    expect(reached[0]).toMatchObject({ call: "ask", machineId: "m-1" });
  });

  test("adopting sends the author to the place, not to a repo root", async () => {
    reached.length = 0;
    answer = plan({ who: "mine", author: ME }, { adopted: true });
    const got = await adoptAuthor(placeHere("/Users/me/alpha"), ME);
    expect(reached[0]).toMatchObject({
      call: "adopt",
      root: "/Users/me/alpha",
      name: "mo",
      email: "mo@users.noreply.auravcs.com",
    });
    expect(got.adopted).toBe(true);
  });

  test("signed out, a place can still be asked who it would author as", async () => {
    reached.length = 0;
    answer = plan({ who: "machine", author: RUNNER, why: "the machine" }, {
      member: null,
    });
    await askAuthor(placeHere("/Users/me/alpha"));
    expect(reached[0]).toMatchObject({ name: null, email: null });
  });
});
