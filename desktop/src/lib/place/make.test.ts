import { describe, expect, test } from "bun:test";

import type { MadePlace, PlaceEntitled, PlaceMakeOffer, PlaceRow } from "../api";
import {
  canOpenItNow,
  canSubmit,
  entitledLine,
  madeLine,
  mayHaveOneMade,
  nameProblem,
  suggestedSize,
  worthRetrying,
} from "./make";

const SIZES = [
  { id: "small", title: "Small", detail: "One person.", suggested: false },
  { id: "medium", title: "Medium", detail: "A couple of people.", suggested: true },
  { id: "large", title: "Large", detail: "A small team.", suggested: false },
];

function offer(over: Partial<PlaceMakeOffer> = {}): PlaceMakeOffer {
  return {
    can_make: true,
    reason: "ready",
    blocked: "",
    org: "Naridon",
    sizes: SIZES,
    entitled: { status: "ok", detail: "", members: ["ana", "mo"], seats: 5 },
    ...over,
  };
}

function entitled(over: Partial<PlaceEntitled> = {}): PlaceEntitled {
  return { status: "ok", detail: "", members: [], seats: 0, ...over };
}

function made(over: Partial<MadePlace> = {}): MadePlace {
  return {
    place_id: "r-1",
    machine_id: "aura@box:/srv/alpha",
    name: "design-box",
    runner_token: "not-a-real-credential",
    entitled: entitled({ members: ["ana"] }),
    note: "",
    ...over,
  };
}

/** Only the two fields this module reads; the row is much wider in the app. */
function place(name: string): PlaceRow {
  return { name } as unknown as PlaceRow;
}

describe("who gets offered the door", () => {
  test("the two roles that may are the two the server reads", () => {
    expect(mayHaveOneMade("owner")).toBe(true);
    expect(mayHaveOneMade("admin")).toBe(true);
    expect(mayHaveOneMade("member")).toBe(false);
    expect(mayHaveOneMade("billing")).toBe(false);
  });

  test("case and padding are the roster's business, not a reason to refuse", () => {
    expect(mayHaveOneMade(" Admin ")).toBe(true);
    expect(mayHaveOneMade("OWNER")).toBe(true);
  });

  test("a role we could not read is not an admin", () => {
    // The alternative draws the door on a maybe, and the refusal then lands
    // after a machine has been made and billed.
    expect(mayHaveOneMade(null)).toBe(false);
    expect(mayHaveOneMade(undefined)).toBe(false);
    expect(mayHaveOneMade("")).toBe(false);
  });

  test("a role nobody has heard of is not an admin either", () => {
    expect(mayHaveOneMade("release-manager")).toBe(false);
  });
});

describe("the size picker", () => {
  test("it starts on the size the backend suggests", () => {
    expect(suggestedSize(offer())).toBe("medium");
  });

  test("with nothing suggested it still starts somewhere", () => {
    // A picker on nothing leaves the primary button disabled with no field to
    // fill in, which is a wizard you cannot finish and cannot diagnose.
    const none = offer({ sizes: SIZES.map((s) => ({ ...s, suggested: false })) });
    expect(suggestedSize(none)).toBe("small");
  });

  test("no sizes at all is an empty choice, not a crash", () => {
    expect(suggestedSize(offer({ sizes: [] }))).toBe("");
  });
});

describe("naming it", () => {
  test("an empty name is unfinished rather than wrong", () => {
    // Shouting at somebody who has not typed yet is how a form greets people
    // with an error before they have done anything.
    expect(nameProblem("", [])).toBeNull();
    expect(nameProblem("   ", [])).toBeNull();
  });

  test("a name already on the board is refused before anything is made", () => {
    const problem = nameProblem("design-box", [place("design-box")]);
    expect(problem).toContain("already have a place called that");
  });

  test("the clash is case-insensitive, because the board's match is", () => {
    expect(nameProblem("Design-Box", [place("design-box")])).not.toBeNull();
    expect(nameProblem(" design-box ", [place("design-box")])).not.toBeNull();
  });

  test("a different name is fine", () => {
    expect(nameProblem("build-box", [place("design-box")])).toBeNull();
  });

  test("a name too long to read in a list is refused", () => {
    expect(nameProblem("x".repeat(61), [])).toContain("too long");
    expect(nameProblem("x".repeat(60), [])).toBeNull();
  });
});

describe("whether the button does anything", () => {
  test("a named, sized, unclashing request from an admin goes", () => {
    expect(canSubmit(offer(), "build-box", "medium", [])).toBe(true);
  });

  test("nothing submits before the offer has loaded", () => {
    expect(canSubmit(null, "build-box", "medium", [])).toBe(false);
  });

  test("a refusal is not something a full form can override", () => {
    const barred = offer({ can_make: false, reason: "not_admin" });
    expect(canSubmit(barred, "build-box", "medium", [])).toBe(false);
  });

  test("a half-filled form does not submit", () => {
    expect(canSubmit(offer(), "  ", "medium", [])).toBe(false);
    expect(canSubmit(offer(), "build-box", "", [])).toBe(false);
  });

  test("a clashing name does not submit", () => {
    expect(canSubmit(offer(), "design-box", "medium", [place("design-box")])).toBe(
      false,
    );
  });
});

describe("saying who will be able to open it", () => {
  test("the people who hold a grant are named", () => {
    const said = entitledLine(entitled({ members: ["ana", "mo"], seats: 5 }));
    expect(said).toContain("@ana");
    expect(said).toContain("@mo");
    expect(said).toContain("2 of 5 seats");
  });

  test("a long list is shortened rather than run on", () => {
    const said = entitledLine(
      entitled({ members: ["ana", "mo", "sam", "kit", "rae"], seats: 10 }),
    );
    expect(said).toContain("@ana");
    expect(said).toContain("3 others");
    expect(said).not.toContain("@rae");
  });

  test("an unmetered team is not told how many seats it has", () => {
    const said = entitledLine(entitled({ members: ["ana"], seats: 0 }));
    expect(said).toContain("@ana");
    expect(said).not.toContain("seats");
  });

  test("nobody granted says what to do about it", () => {
    const said = entitledLine(entitled({ members: [], seats: 3 }));
    expect(said).toContain("cloud access");
  });

  test("we could not ask is never drawn as nobody has access", () => {
    // The two send a person to opposite places: one to a settings page to hand
    // out seats, the other to wait a minute and reload.
    const unknown = entitledLine(entitled({ status: "unknown", detail: "no answer" }));
    const nobody = entitledLine(entitled({ members: [] }));
    expect(unknown).not.toBe(nobody);
    expect(unknown).toContain("couldn't check");
    expect(entitledLine(null)).toContain("couldn't check");
  });
});

describe("after it exists", () => {
  test("a clean run says it is ready and whose board it is on", () => {
    const said = madeLine(made());
    expect(said).toContain("design-box");
    expect(said).toContain("board");
  });

  test("a note about what went wrong wins over the success line", () => {
    // The place is real; something else is not. Burying that under "ready"
    // leaves somebody wondering why their machine is not in the list.
    const said = madeLine(made({ note: "This laptop couldn't save its address." }));
    expect(said).toBe("This laptop couldn't save its address.");
  });

  test("it can be opened straight away only when this laptop has its address", () => {
    expect(canOpenItNow(made())).toBe(true);
    expect(canOpenItNow(made({ machine_id: "" }))).toBe(false);
  });
});

describe("whether asking again could change the answer", () => {
  test("a roster read that didn't come back is worth another go", () => {
    expect(worthRetrying("unknown_role")).toBe(true);
  });

  test("a settled fact offers no button that spins", () => {
    // A retry on "you are not an admin" lands on the same sentence, which
    // reads as a bug rather than as an answer.
    for (const reason of ["not_admin", "not_offered", "signed_out", "no_org"]) {
      expect(worthRetrying(reason)).toBe(false);
    }
  });

  test("a reason this build has never heard of is not retried either", () => {
    expect(worthRetrying("something-new")).toBe(false);
  });
});
