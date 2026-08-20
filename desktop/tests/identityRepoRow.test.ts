// A project with no git email says so, and only offers what can work.
//
//   bun test
//
// Driven in a real window, Settings > Personal > Identity showed three
// projects, each one reading:
//
//     mixrank                        Committing as an unset git email
//     We don't recognise this email on your team yet.
//     [ I'm new. Add me ]  [ Pick someone else ]
//
// Three problems in one row. The value slot held a description of the hole
// instead of a value. The sentence below asked the reader to recognise an
// email that doesn't exist. And "I'm new. Add me" runs `team_claim`, which
// reads `git config user.email` and answers "git user.email is not configured
// for this repo" — a button whose only outcome is an error.
//
// Picking a teammate is the one action that still works: the pin is stored
// against the project (`identity_override_set`), not against the email.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const SRC = "components/identity/IdentityRepoRow.tsx";

describe("identity row without a git email", () => {
  test("the missing email is named, not dressed up as one", async () => {
    const src = await readSrc(SRC);
    expect(src).toContain("const noEmail = !status.email?.trim()");
    expect(src).toContain("No git email set here");
    // The old string read as an address right up to the last two words.
    expect(src).not.toContain("an unset git email");
  });

  test("the sentence matches which of the two situations this is", async () => {
    const src = await readSrc(SRC);
    expect(src).toContain(
      "Git has no email for you in this project, so Aura can",
    );
    // Still the right words when there IS an email and the team doesn't
    // know it — that case was never broken.
    expect(src).toContain("We don&apos;t recognise this email on your team yet");
    // And a roster nobody has joined is its own dead end, said plainly
    // rather than by offering a picker with nothing in it.
    expect(src).toContain("nobody has");
  });

  test("the two claim actions are withheld, the working one is offered", async () => {
    const src = await readSrc(SRC);
    // `team_claim` cannot succeed without an email.
    expect(src).toContain('{!noEmail && status.confusion !== "not_on_roster" && (');
    expect(src).toContain('{!noEmail && status.confusion === "not_on_roster" && (');
    // Picking still works — and being the only action, it stops looking
    // like the afterthought next to a primary button that isn't there.
    expect(src).toContain('variant={noEmail ? "default" : "subtle"}');
    expect(src).toContain('{noEmail ? "Pick who you are" : "Pick someone else"}');
  });
});
