// The frontend half of "one door to the wire".
//
// `cloudbox::sole_ssh` keeps the Rust side honest: one line spawns ssh, one
// calls it, every command that names a machine goes through `Place`. That guard
// could have stayed green forever while this side of the app dialled boxes
// perfectly happily out of a string builder in TypeScript — which is exactly
// what it did. So the same claim is made here, about this half.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, mock, test } from "bun:test";

import type { Machine } from "../api";
import {
  isProductionSource,
  sideDoors,
  type Source,
} from "../../../tests/support/soleSsh";
import { placeHere, placeOfMachine } from "./contract";

// Every boot the seam asked for, in order.
const asked: Array<{
  place: { root?: string | null; machineId?: string | null; address?: unknown };
  open: unknown;
}> = [];
let answer: string | Error = "sh -c 'exec \"$SHELL\" -l'";

mock.module("../api", () => ({
  api: {
    placeBoot: async (place: (typeof asked)[number]["place"], open: unknown) => {
      asked.push({ place, open });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  },
}));

const {
  askBoot,
  askBootAt,
  canOpenTerminal,
  dialableName,
  isDialableAddress,
  openAgent,
  openAttach,
  openShell,
} = await import("./boot");

function box(over: Partial<Machine> = {}): Machine {
  return {
    id: "ubuntu@10.0.0.1:/srv/aura",
    name: "aura-runner",
    host: "10.0.0.1",
    user: "ubuntu",
    key_path: "/keys/aura.pem",
    box_kind: "mine",
    repo_path: "/srv/aura",
    project_root: "/Users/mo/aura",
    repo_branch: null,
    added_at: 1,
    last_used_at: 2,
    ...over,
  };
}

describe("asking a place for a terminal", () => {
  test("the ask names the place; nothing about a transport is decided here", () => {
    asked.length = 0;
    void askBoot(placeOfMachine(box()), openAttach("aura-agent-3f1"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.place).toEqual({
      root: "/Users/mo/aura",
      machineId: "ubuntu@10.0.0.1:/srv/aura",
    });
  });

  test("this laptop is asked the same question, with no machine to name", () => {
    // The parity claim in one assertion: the local arm is not a different
    // function, it is the same call with a null where the box would be.
    asked.length = 0;
    void askBoot(placeHere("/Users/mo/aura"), openShell("aura-work"));
    expect(asked[0]?.place).toEqual({
      root: "/Users/mo/aura",
      machineId: null,
    });
  });

  test("a box the machine book has never seen is named by address", () => {
    // The connect wizard's whole case: dial first, write the row down when the
    // shell answers, so a typo leaves nothing behind.
    asked.length = 0;
    const address = {
      user: "ubuntu",
      host: "box.example",
      key_path: "~/keys/box.pem",
      kind: "mine" as const,
    };
    void askBootAt(address, openShell());
    expect(asked[0]?.place).toEqual({ address });
  });

  test("what to open crosses the wire spelled the way Rust spells it", () => {
    // `read_only`, not `readOnly`. This value is serialised straight into
    // `place_contract::Open`, so a nicer name here is a field the backend
    // silently never sees — an attach that quietly takes the keyboard from
    // whoever is already typing in that session.
    expect(openAttach("s", true)).toEqual({
      what: "attach",
      session: "s",
      read_only: true,
    });
    expect(openAttach("s")).toEqual({
      what: "attach",
      session: "s",
      read_only: false,
    });
    expect(openShell()).toEqual({ what: "shell", session: null });
    expect(openAgent("claude", { prompt: "hi" })).toEqual({
      what: "agent",
      bin: "claude",
      prompt: "hi",
      session: null,
    });
  });

  test("a place that cannot be named is an error, not a line", () => {
    answer = new Error("That isn't an address this laptop can dial.");
    const boom = askBoot(placeOfMachine(box()), openShell());
    answer = "sh -c 'exec \"$SHELL\" -l'";
    return expect(boom).rejects.toThrow("isn't an address");
  });
});

describe("whether a place can be opened at all", () => {
  test("this laptop always can, and is not asked about dialling", () => {
    // Spelled `isDialable` this would have said no — and disabled the control
    // that opens a terminal on the one place that is always reachable.
    expect(canOpenTerminal(placeHere("/Users/mo/aura"))).toBe(true);
    expect(canOpenTerminal(placeHere(null))).toBe(true);
  });

  test("a box is judged on its saved address", () => {
    expect(canOpenTerminal(placeOfMachine(box()))).toBe(true);
    expect(canOpenTerminal(placeOfMachine(box({ host: "box; id" })))).toBe(false);
    expect(canOpenTerminal(placeOfMachine(box({ key_path: "  " })))).toBe(false);
  });

  test("it agrees, row for row, with the Rust that actually dials", () => {
    // `cloudbox::is_dialable` reads the same file and asserts the same rows.
    // A copy that quietly stopped agreeing is a button that opens a terminal
    // onto an address the backend then refuses — or one that is disabled on an
    // address that works.
    const table = JSON.parse(
      readFileSync(
        new URL(
          "../../../src-tauri/src/cloudbox/dialable.cases.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      cases: {
        user: string;
        host: string;
        key_path: string;
        dialable: boolean;
        why: string;
      }[];
    };

    expect(table.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of table.cases) {
      expect({ case: c.why, dialable: isDialableAddress(c) }).toEqual({
        case: c.why,
        dialable: c.dialable,
      });
    }
  });

  test("a name is a name, not an argument", () => {
    expect(dialableName("box.example.com")).toBe(true);
    expect(dialableName("  box.example  ")).toBe(true);
    expect(dialableName("-oProxyCommand=x")).toBe(false);
    expect(dialableName("")).toBe(false);
  });
});

describe("one door to the wire, from this side", () => {
  test("nothing in the frontend assembles an ssh line any more", () => {
    // The end of path C. A surface that builds its own `-i key user@host` has
    // forked the transport whether or not it ever runs it: connection
    // multiplexing, quoting and whatever a managed place needs instead of ssh
    // all live on the other side of `place_boot`, and a second builder here
    // would keep dialling ssh at a place that no longer answers to one.
    //
    // The rule and the reading now come from `tests/support/soleSsh`, which
    // asks this of the whole repo in five languages. This test keeps its own
    // name and its own corpus — `aura-shell/src`, the half that actually forked
    // — because it is the one that will fail first and most usefully when it
    // forks again. What it no longer keeps is a second copy of how to read a
    // file: the private one here was line-based, so a builder written across
    // two lines slipped straight past it.
    const offenders = sideDoors(production());
    expect(
      offenders.map((s) => `${s.path}:${s.line} (${s.rule}) — ${s.text}`),
    ).toEqual([]);
  });
});

/** Every TypeScript file the app ships, as the shared guard wants them.
 *
 *  Tests are left out: this file's own patterns, and the terminal streams other
 *  tests use as fixtures, are made of exactly what it is looking for. */
function production(): Source[] {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const out: Source[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        walk(path);
        continue;
      }
      const rel = path.slice(root.length + 1);
      if (!/\.tsx?$/.test(e.name) || !isProductionSource(rel)) continue;
      out.push({ path: rel, text: readFileSync(path, "utf8") });
    }
  };
  walk(root);

  // A walk that found nothing would pass the assertion above in silence, which
  // is worse than having no guard at all.
  expect(out.length).toBeGreaterThan(100);
  return out;
}
