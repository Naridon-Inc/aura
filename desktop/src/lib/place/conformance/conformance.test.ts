// The parity proof, not a smoke test.
//
// A mode is not shipped until its column is green. Everything here is one of
// two claims: the table holds, or the table is honest about where it doesn't.
//
// The other half of this suite lives in `manager::brain::place_conformance` and
// runs under `cargo test`. Both are needed and neither replaces the other: Rust
// asks what a place will DO, this asks whether every surface can treat a place
// as a place. The frontend's own way of shipping a feature in one mode only is
// a component that special-cases `machineId === null`, and no amount of Rust
// catches that.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import type { Machine } from "../../api";
import { fakeApi } from "./probe";

mock.module("../../api", () => ({ api: fakeApi }));

import type { Mode } from "./matrix";
import {
  ALPHA,
  MANAGED_KEY_REF,
  MODES,
  ORG,
  WORKFLOWS,
  auraDrivesLifecycle,
  auraMadeThisPlace,
  managedRow,
  whoPays,
} from "./matrix";
import { CHECKS } from "./workflows";
import { cell, cellCount, declaredAsymmetries, runMatrix } from "./runner";
import { canOpenTerminal } from "../boot";
import { placeOfMachine } from "../contract";
import { isGrantedHandle } from "../grant";

// One workflow is about a broadcast, which needs something to broadcast on.
// Restored afterwards because every test file in this run shares one process,
// and a global left behind is a failure in somebody else's file.
const hadWindow = "window" in globalThis;
const previousWindow = (globalThis as { window?: unknown }).window;

beforeAll(() => {
  (globalThis as { window?: unknown }).window = new EventTarget();
});

afterAll(() => {
  if (hadWindow) (globalThis as { window?: unknown }).window = previousWindow;
  else delete (globalThis as { window?: unknown }).window;
});

describe("the contract conformance suite", () => {
  test("every place runs the whole workflow matrix", async () => {
    const failures = await runMatrix();
    expect(
      failures,
      `${failures.length} of ${cellCount()} cells did not hold:\n  ${failures.join("\n  ")}`,
    ).toEqual([]);
  });

  test("every check answers every mode", async () => {
    // A check that only knew how to answer one of them would land here rather
    // than in a mode-shaped test file somebody forgot to write.
    let asked = 0;
    for (const mode of MODES) {
      for (const workflow of WORKFLOWS) {
        const outcome = await CHECKS[workflow.id](mode).catch((e: unknown) => {
          throw new Error(
            `${workflow.id} was not answerable about ${mode.id}: ${String(e)}`,
          );
        });
        expect(outcome.note.trim().length).toBeGreaterThan(0);
        asked += 1;
      }
    }
    expect(asked).toBe(cellCount());
    expect(asked).toBe(60); // four modes, fifteen workflows
  });

  test("the managed row arrived as one table entry and was asked everything", async () => {
    // The acceptance criterion, executed rather than rehearsed. The Aura-managed
    // arm is one entry: a row whose box_kind is managed, and an EMPTY
    // not-promised, because the two amber cells are exactly what it exists to
    // close. Nothing else moved — not a check, not the runner, not the workflow
    // list — which is why this test can be written against the shipped table
    // instead of against a row it makes up.
    const managed = MODES.find((m) => m.id === "managed");
    expect(managed, "the managed row is not in the table").toBeDefined();
    expect(managed!.notPromised).toEqual([]);
    expect(cellCount()).toBe(60);

    // And it closes them by being what it is, not by declaring anything: both
    // cells the box row is amber on are green here.
    for (const id of ["W11", "W13"] as const) {
      const workflow = WORKFLOWS.find((w) => w.id === id);
      expect(await cell(managed!, workflow!)).toBeNull();
      const outcome = await CHECKS[id](managed!);
      expect(outcome.kind).toBe("met");
    }
  });

  test("the row under that column is a machine whose key the member never has", () => {
    // A green column is worth what the row under it is worth, and this is the
    // field the row was likeliest to get wrong — because every other row in the
    // table carries a `.pem` path and one here would have looked right. It would
    // also have made all fifteen cells green about a place Aura never makes:
    // the whole point of a machine Aura made is that the member is never given
    // its key, and a fixture with a path in it proves the opposite thing.
    //
    // Spelled as the reference `cmd_machines::made_machine` writes into the row,
    // which is what the backend turns into a local agent instead of an `-i`.
    const row = managedRow(ALPHA, ORG);
    expect(row.key_path).toBe(MANAGED_KEY_REF);
    expect(row.key_path.startsWith("/")).toBe(false);
    expect(row.key_path).not.toContain("/");

    // And nothing above the seam may read that difference. A place built from
    // this row opens a terminal on the same gate every other place does.
    expect(canOpenTerminal(placeOfMachine(row))).toBe(true);
  });

  test("the granted column is the brought one plus a permission and nothing else", () => {
    // What makes the fourth row worth its fifteen cells. If it differed in the
    // metal, or in who pays, then its green W13 would be evidence about some
    // other kind of machine and would prove nothing about the box a customer
    // already owns. So: same hardware, same login, same key on this Mac, same
    // bill, same org — and one field that says somebody opened up the account.
    const brought = MODES.find((m) => m.id === "box")!.row(ALPHA, ORG);
    const granted = MODES.find((m) => m.id === "granted")!.row(ALPHA, ORG);
    for (const field of [
      "box_kind",
      "host",
      "user",
      "key_path",
      "repo_path",
      "project_root",
      "org_slug",
    ] as const) {
      expect(granted[field], `the granted row differs on ${field}`).toEqual(
        brought[field],
      );
    }
    const grantedPlace = placeOfMachine(granted);
    expect(whoPays(grantedPlace)).toBe(whoPays(placeOfMachine(brought)));
    expect(auraMadeThisPlace(grantedPlace)).toBe(false);

    // And the one field that did change is a grant rather than an ordinary
    // handle, because an unqualified one would be Aura claiming the machine as
    // its own rather than acting in somebody else's account.
    expect(isGrantedHandle(grantedPlace.lifecycleHandle)).toBe(true);
    expect(auraDrivesLifecycle(grantedPlace)).toBe(true);
    expect(isGrantedHandle(placeOfMachine(brought).lifecycleHandle)).toBe(false);
  });

  test("the only asymmetries are the ones declared up front", () => {
    // Two rows, three entries, and the shape of that list is the finding. The
    // box row is amber twice and they turned out to be different differences:
    // one is about hardware nobody can share and survives every grant, the other
    // was only ever about permission and goes away the moment somebody hands
    // Aura a role. The granted row is the proof — same box, same bill, amber
    // once. A fourth entry appearing here is a product decision, not a test
    // edit.
    expect(declaredAsymmetries()).toEqual([
      ["box", "W11"],
      ["box", "W13"],
      ["granted", "W11"],
    ]);

    for (const mode of MODES) {
      for (const [id, why] of mode.notPromised) {
        expect(WORKFLOWS.some((w) => w.id === id)).toBe(true);
        // An excuse nobody can read is an excuse nobody can challenge.
        expect(
          why.length,
          `${mode.id} × ${id} says it does not promise this without saying what it does instead`,
        ).toBeGreaterThan(80);
      }
    }
  });

  test("a failure names which mode failed which workflow", async () => {
    // A red cell has to be findable. "expected 0 to be 6" in a table this size is a
    // morning spent bisecting, so every line carries the mode, the workflow's id
    // and the workflow in the words it was specified in.
    const w1 = WORKFLOWS[0];
    const lying: Mode = {
      ...MODES[0],
      notPromised: [["W1", "a stale excuse, left in the table"]],
    };
    const stale = await cell(lying, w1);
    expect(stale).toStartWith("here × W1 (open a project):");
    expect(stale).toContain("Take the entry out of the table");

    // And the other direction: a mode that stops doing something it never had
    // an excuse for is named the same way.
    const w13 = WORKFLOWS.find((w) => w.id === "W13")!;
    const undeclared = await cell({ ...MODES[1], notPromised: [] }, w13);
    expect(undeclared).toStartWith(
      "box × W13 (sleep on idle and wake on demand):",
    );
    expect(undeclared).toContain("nothing in the table says so");

    // And a floor that collapses is red even where the table has an excuse. A
    // real row with nothing in the fields a place is built from — not a mode
    // declining to promise something, a place that cannot answer at all.
    const broken: Mode = {
      ...MODES[1],
      row: () => managedRow({ here: "", there: "", branch: "" }, null),
      notPromised: [["W1", "an excuse that cannot cover a broken floor"]],
    };
    expect(await cell(broken, w1)).toContain("the contract broke");
  });

  test("no check asks which mode of place it is holding", async () => {
    // The rule that keeps this a contract suite rather than two test files
    // sharing a directory. A check that read the kind, or the row's own id,
    // would keep passing while the modes drifted apart — which is the one
    // failure the matrix exists to catch.
    //
    // `"shared"` is deliberately not on this list: it is also a credential's
    // answer to "is this everybody's", and W10 must be able to say so.
    const source = await Bun.file(
      new URL("./workflows.ts", import.meta.url),
    ).text();
    const code = source.split("\n").filter((line) => {
      const t = line.trim();
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
    for (const forbidden of [
      "identity.kind",
      '"managed"',
      "mode.id",
      "mode.title",
      "machineId === null",
      "machineId !== null",
    ]) {
      expect(
        code.filter((l) => l.includes(forbidden)),
        `a check is branching on ${forbidden}`,
      ).toEqual([]);
    }
  });
});
