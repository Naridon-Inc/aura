// The parity gate: nothing in this repo reaches a machine except through the
// door.
//
//   bun test
//
// This is the assertion the whole place programme rests on. Every feature that
// asks something of a box — what sessions it holds, whose account is on it, who
// authored the commit, which projects it may show you — is only *equally* true
// of a place Aura provisions and a place you brought because all of them go
// through one seam. A surface three lines away from writing its own `ssh -i …`
// will work perfectly on the box you brought and simply not exist on the other
// one. That is not a bug anybody reports. It is a feature that quietly lives in
// one place-mode only, which is the one thing this programme is not allowed to
// ship.
//
// Two guards already made this claim and both had a hole:
//
//   * `cloudbox/sole_ssh.rs` asks it of Rust — and only under `cargo test`. The
//     crew's verify command runs `cargo check --lib`, which does not compile
//     tests, so the guard that decides whether Rust work lands was not running
//     in the gate that decides whether work lands.
//   * `lib/place/boot.test.ts` asks it of `aura-shell/src` — one directory of
//     one app, out of a repo holding a marketing site, a mobile app, an
//     extension, a CLI, a cloud server and fifty shell scripts.
//
// The transport has forked exactly once, and it forked into the gap: a whole
// second way to reach a box, written in TypeScript, while the Rust guard stayed
// green. So this one reads every file in the repo it can read, in every
// language, and it runs in `bun test` — which is what the crew verify command
// actually executes.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXEMPT,
  THE_DIALER,
  THE_DOOR,
  THE_DOORWAY,
  exemptionFor,
  isProductionSource,
  sideDoors,
  unearnedExemptions,
  unreadableSources,
  type Source,
} from "./support/soleSsh";
import { isReadable } from "./support/sourceKinds";

/** Where the Rust half of this claim lives. */
const RUST_GUARD = "aura-shell/src-tauri/src/cloudbox/sole_ssh.rs";

describe("one door to the wire", () => {
  test("nothing outside cloudbox spawns ssh or assembles an ssh argv", () => {
    const found = sideDoors(corpus());
    // Named, not counted. A guard that says "3 violations" sends whoever broke
    // it grepping; one that names the file and the line is one they can act on
    // before they have finished reading the failure.
    expect(
      found.map((s) => `${s.path}:${s.line} (${s.rule}) — ${s.text}`),
    ).toEqual([]);
  });

  test("the door is still the door", () => {
    // The assertion above passes trivially if the door moved and took the word
    // with it, or if the corpus stopped containing the one file that is
    // *supposed* to hold a spawn. So the positive case is asserted too.
    const files = corpus();
    const door = files.find((f) => f.path === THE_DOOR);
    expect(door?.text).toContain('Command::new("ssh")');

    const dialer = files.find((f) => f.path === THE_DIALER);
    expect(dialer?.text).toContain('program: "ssh".into()');

    // And both are exempt for the reason they are the door, not for some
    // reason somebody added later.
    expect(exemptionFor(THE_DOOR)?.kind).toBe("door");
    expect(exemptionFor(THE_DIALER)?.kind).toBe("door");
  });

  test("every exemption still earns its exemption", () => {
    // The list is where a guard goes to die: an entry added under deadline,
    // then another, and the invariant is gone while the test still passes. Each
    // one carries an obligation that is checked rather than trusted — an ops
    // script must stay unreachable from what ships, a drawing of a command must
    // stay unable to run one.
    expect(unearnedExemptions(corpus())).toEqual([]);
  });

  test("every exemption says why, in a sentence a person can argue with", () => {
    for (const e of EXEMPT) {
      expect({ path: e.path, why: e.why.length > 40 }).toEqual({
        path: e.path,
        why: true,
      });
      expect(e.why).toMatch(/[.!]$/);
    }
    // No duplicates: two entries for one path means one of them is unread, and
    // the unread one is the one that stops being true.
    expect(new Set(EXEMPT.map((e) => e.path)).size).toBe(EXEMPT.length);
  });

  test("both halves run in the command that decides whether work lands", () => {
    // A guard that isn't in the gate is a guard nobody runs. That is not
    // hypothetical here: the crew verify command runs `cargo check --lib`,
    // which does not compile tests, so `sole_ssh.rs` — the guard that was
    // supposed to stop exactly the fork that happened — was invisible to it for
    // as long as it existed.
    //
    // `bun test` is where this file runs, and `verify` is the one command that
    // runs both halves. Asserted rather than documented, because a script
    // trimmed in a hurry looks like tidying and reads as coverage.
    const scripts = JSON.parse(read("aura-shell/package.json")).scripts as Record<
      string,
      string
    >;
    expect(scripts.verify).toContain("bun test");
    expect(scripts.verify).toContain("cargo test --lib");
    expect(scripts["verify:parity"]).toContain("oneDoorToTheWire");
    expect(scripts["verify:parity"]).toContain("sole_ssh");
  });

  test("the Rust half of this guard is still there and still agrees", () => {
    // This guard is wide and shallow — it asks only that nothing reaches the
    // wire. `sole_ssh.rs` is narrow and deep: it asks that only `Place` dials,
    // that `Place` has exactly one way out, and that every command naming a
    // machine is a `Place` call. Neither subsumes the other, so losing either
    // is a real loss. Pinned by the two paths both of them name, which is the
    // thing that would drift first if the door ever moved.
    const rust = read(RUST_GUARD);
    expect(rust).toContain(THE_DOOR);
    expect(rust).toContain(THE_DIALER);
    expect(rust).toContain("fn one_line_in_the_repo_spawns_ssh");
    expect(rust).toContain("fn nothing_else_in_the_repo_writes_an_ssh_line");
  });
});

describe("the corpus this is claiming about", () => {
  // A walk that found nothing passes every assertion above in silence, which is
  // worse than having no guard at all — and is precisely how the TypeScript
  // fork survived: a guard that was green because it was not looking.
  test("it is the whole repo, not one app", () => {
    const files = corpus();
    expect(files.length).toBeGreaterThan(1500);

    // Every part of the product that could hold a second transport, named
    // rather than assumed. `aura-web` is on this list because it is where the
    // one live exemption is; the rest are here because a guard that silently
    // stopped walking a directory would look exactly like a guard that found
    // nothing there.
    for (const part of [
      "aura-shell/src/",
      "aura-shell/src-tauri/src/",
      "aura-cli/src/",
      "aura-web/src/",
      "aura-mobile/",
      "aura-runner/",
      "scripts/",
    ]) {
      expect({
        part,
        walked: files.some((f) => f.path.startsWith(part)),
      }).toEqual({ part, walked: true });
    }
  });

  test("it reads five languages, not one", () => {
    const files = corpus();
    for (const ext of [".rs", ".ts", ".tsx", ".sh", ".py"]) {
      expect({
        ext,
        seen: files.some((f) => f.path.endsWith(ext)),
      }).toEqual({ ext, seen: true });
    }
  });

  test("nothing in it is a file this cannot read", () => {
    // The corpus is built out of readable extensions, so this is a statement
    // about the two staying in step: a language added to the walk but not to
    // the reader would be walked, read as nothing, and pass.
    expect(unreadableSources(corpus())).toEqual([]);
  });

  test("tests are left out, and the guards' own fixtures with them", () => {
    // `boot.test.ts` asserts what an ssh line looks like and `remoteShell.test.ts`
    // keeps one as a fixture. Reading those as side doors would make the guard
    // fire on the tests proving there are none — the fastest possible route to
    // it being deleted.
    expect(isProductionSource("aura-shell/src/lib/place/boot.test.ts")).toBe(false);
    expect(
      isProductionSource("aura-shell/src/components/commons/crew/remoteShell.test.ts"),
    ).toBe(false);
    expect(isProductionSource("aura-shell/src/lib/place/boot.ts")).toBe(true);
    expect(corpus().some((f) => /\.test\.tsx?$/.test(f.path))).toBe(false);
  });

  test("the door's own directory is in the corpus, and exempt as a whole", () => {
    // Not skipped by the walk — skipping it would mean the "door is still the
    // door" assertion above has nothing to read. It is exempt by rule instead,
    // which is a decision written down rather than a gap in a traversal.
    const files = corpus();
    expect(files.some((f) => f.path.startsWith(THE_DOORWAY))).toBe(true);
    expect(exemptionFor(`${THE_DOORWAY}script.rs`)?.kind).toBe("door");
  });
});

// ---------------------------------------------------------------------------
// Reading the repo
// ---------------------------------------------------------------------------

/** Cached: the walk is the expensive part and every test above wants it. */
let walked: Source[] | null = null;

function corpus(): Source[] {
  if (walked) return walked;
  const root = repoRoot();
  const out: Source[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skipped(e.name)) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        walk(path);
        continue;
      }
      const rel = path.slice(root.length + 1);
      if (!isReadable(rel) || !isProductionSource(rel)) continue;
      out.push({ path: rel, text: readFileSync(path, "utf8") });
    }
  };
  walk(root);
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  walked = out;
  return out;
}

/**
 * Build output, dependencies, and anything hidden.
 *
 * `target` alone holds more Rust than everything ever written here, and this
 * repo's parallel work happens in worktrees under `.claude` — walking those
 * would read four other branches' code and report their side doors as this
 * one's.
 */
function skipped(name: string): boolean {
  return (
    name.startsWith(".") ||
    ["target", "node_modules", "dist", "build", "vendor", "Pods"].includes(name)
  );
}

/**
 * Upwards until something holds a `.git`.
 *
 * A file, not only a directory: in a worktree — which is how this repo's
 * parallel work is done — `.git` is a one-line pointer at the real one.
 */
function repoRoot(): string {
  let dir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (;;) {
    try {
      statSync(join(dir, ".git"));
      return dir;
    } catch {
      const up = dirname(dir);
      if (up === dir) throw new Error("no .git above the test file");
      dir = up;
    }
  }
}

function read(rel: string): string {
  return readFileSync(join(repoRoot(), rel), "utf8");
}
