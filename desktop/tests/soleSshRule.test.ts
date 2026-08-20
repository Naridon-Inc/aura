// What counts as reaching the wire — and proof that the gate goes red.
//
//   bun test
//
// `oneDoorToTheWire.test.ts` asserts that the repo is clean. That assertion is
// worthless on its own: a guard that has never gone red is indistinguishable
// from a guard that cannot. So every rule is exercised here against a file
// written to break it, and against the near-misses that must NOT break it —
// because a guard with false positives gets an exemption added, and the
// exemption list is where guards go to die.

import { describe, expect, test } from "bun:test";

import {
  EXEMPT,
  THE_DIALER,
  THE_DOOR,
  THE_DOORWAY,
  exemptionFor,
  isProductionSource,
  sideDoors,
  sightings,
  unearnedExemptions,
  type Source,
} from "./support/soleSsh";

/** A one-file corpus, so a rule can be asked about exactly one thing. */
const one = (path: string, text: string): Source[] => [{ path, text }];

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * A corpus in which every non-ops exemption is already satisfied.
 *
 * Each obligation is checked against the whole corpus, so a synthetic one built
 * from two files fails every *other* exemption for being absent — true, and not
 * what the test in hand is asking about. This supplies the innocent versions so
 * the assertion is about the one thing being broken.
 */
function intact(): Source[] {
  return EXEMPT.filter((e) => e.kind === "mock").map((e) => ({
    path: e.path,
    text: "const shown = ['ssh', '-i', key].join(' ');",
  }));
}

describe("spawning ssh", () => {
  test("a TypeScript surface that spawns it is caught", () => {
    const found = sideDoors(
      one("aura-shell/src/components/cloud/Reach.tsx", `Bun.spawn(["ssh", host]);`),
    );
    expect(found.map((s) => s.rule)).toEqual(["spawns"]);
    expect(found[0]!.line).toBe(1);
  });

  test("a Rust file outside the door that spawns it is caught", () => {
    const found = sideDoors(
      one("aura-cli/src/reach.rs", 'pub fn go() { Command::new("ssh").arg(h); }'),
    );
    expect(found.map((s) => s.rule)).toEqual(["spawns"]);
  });

  test("a shell script that runs it is caught", () => {
    const found = sideDoors(one("scripts/reach.sh", 'ssh -i "$KEY" "$USER@$HOST" uptime'));
    expect(found).not.toEqual([]);
  });

  test("a Python helper that runs it is caught", () => {
    const found = sideDoors(one("scripts/reach.py", 'run(["ssh", "-i", key, target])'));
    expect(found.map((s) => s.rule)).toEqual(["spawns"]);
  });

  test("it is caught wherever in the file it is, and reported at its line", () => {
    const src = ["const a = 1;", "", "// nothing here", 'const b = spawn("ssh");'].join("\n");
    const found = sideDoors(one("aura-mobile/src/reach.ts", src));
    expect(found.map((s) => s.line)).toEqual([4]);
    expect(found[0]!.text).toBe('const b = spawn("ssh");');
  });
});

describe("assembling an ssh argv without spawning it", () => {
  // The half people miss. A surface that builds `-i key -o … user@host` has
  // forked the transport whether or not it runs it: multiplexing, the agreed
  // quoting and whatever a managed place needs *instead* of ssh all live on the
  // far side of the door, and a place not reached over ssh at all could never
  // be added to a line built here.
  test("a strict-host-key option in a string is enough", () => {
    const found = sideDoors(
      one(
        "aura-shell/src/lib/reach.ts",
        'const argv = ["-o", "StrictHostKeyChecking=accept-new", `${user}@${host}`];',
      ),
    );
    expect(found.map((s) => s.rule)).toEqual(["assembles"]);
  });

  test("so is the multiplexing control path, which is what a fork always lacks", () => {
    const found = sideDoors(one("aura-cli/src/reach.rs", 'args(["-o", "ControlPath=none"])'));
    expect(found.map((s) => s.rule)).toEqual(["assembles"]);
  });

  test("so is an ssh line handed to another program to run", () => {
    // `rsync -e "ssh -i …"` never spawns ssh itself. The transport is forked
    // just the same.
    const found = sideDoors(
      one("scripts/push.sh", 'rsync -az -e "ssh -i $KEY" "$DIST/" "$HOST:/tmp/"'),
    );
    expect(found).not.toEqual([]);
  });
});

describe("what must not be caught", () => {
  // Each of these is a real line from this repo. A guard that fires on any of
  // them is a guard somebody switches off.
  test("prose about the transport that was removed", () => {
    const src = [
      "// It used to build the `ssh` lines too: `sshLine`, `remoteShellCommand`,",
      "// all assembled out of three fields off a machine row, with -i and",
      "// -o StrictHostKeyChecking=accept-new. That is now `Place::boot`.",
      "export const SHELL_READY = \"___AURA_SHELL_READY___\";",
    ].join("\n");
    expect(sideDoors(one("aura-shell/src/components/commons/crew/remoteShell.ts", src))).toEqual(
      [],
    );
  });

  test("a word that merely contains the three letters", () => {
    const src = [
      "let argv = ssh_argv(machine, &line, true);",
      "if is_dialable(&m) { redial(&m); }",
      'let key = "aura-runner-ssh-key.pem";',
      "mount_sshfs(target);",
    ].join("\n");
    expect(sideDoors(one("aura-cli/src/other.rs", src))).toEqual([]);
  });

  test("a scheme mapped to its port names the protocol, not a program", () => {
    // `aura-egress` decides what a place is allowed to reach, and its policy
    // holds a scheme-to-port table. Nothing on that line can reach anything —
    // and the guard that fired on it was the Rust one, on another branch, which
    // is how this arrived: a false positive on a *policy* file is the fastest
    // possible argument for switching the guard off.
    const src = [
      "fn port_of(scheme: &str) -> u16 {",
      "    match scheme {",
      '        "https" => 443,',
      '        "ssh" => 22,',
      "        _ => 0,",
      "    }",
      "}",
    ].join("\n");
    expect(sideDoors(one("aura-egress/src/policy.rs", src))).toEqual([]);
    // The same shape in the other languages that write one.
    expect(sideDoors(one("aura-shell/src/lib/ports.ts", 'const PORTS = { ssh: 22, https: 443 };'))).toEqual(
      [],
    );
    expect(sideDoors(one("scripts/ports.py", 'PORTS = {"ssh": 22}'))).toEqual([]);
  });

  test("a port table that grows a way to run something is caught again", () => {
    // The carve-out is about the shape of a line, so it has to stop applying
    // the moment the line does something. Otherwise it is a two-character
    // bypass: append `=> 22` and the guard goes quiet.
    const found = sideDoors(
      one("aura-egress/src/policy.rs", 'let p = Command::new("ssh"); let n = "ssh" => 22;'),
    );
    expect(found.map((s) => s.rule)).toEqual(["spawns"]);
  });

  test("a field beside a port is not a mapping to one", () => {
    // `{ program: "ssh", port: 22 }` is a command with a port next to it, which
    // is exactly the thing being looked for.
    const found = sideDoors(
      one("aura-shell/src/lib/reach.ts", 'const spec = { program: "ssh", port: 22 };'),
    );
    expect(found.map((s) => s.rule)).toEqual(["spawns"]);
  });

  test("a live test that dials a real box on purpose", () => {
    // Every place module has one, and every one of them would fail a grep.
    const src = [
      "pub fn ships() {}",
      "#[cfg(test)]",
      "mod tests {",
      '    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]',
      "    fn observe() {",
      '        Command::new("ssh").args(["-o", "BatchMode=yes"]).output();',
      "    }",
      "}",
    ].join("\n");
    expect(sideDoors(one("aura-shell/src-tauri/src/manager/brain/place_open.rs", src))).toEqual(
      [],
    );
  });

  test("a test file, in any language", () => {
    const argv = 'const line = "ssh -i \\"$HOME/key.pem\\" ubuntu@203.0.113.10";';
    for (const path of [
      "aura-shell/src/lib/place/boot.test.ts",
      "aura-shell/src/components/commons/crew/remoteShell.test.ts",
      "aura-shell/tests/support/soleSsh.ts",
    ]) {
      expect({ path, production: isProductionSource(path) }).toEqual({
        path,
        production: false,
      });
    }
    // And the corpus builder is what applies that: the rule itself still sees a
    // line for what it is, which is why the exclusion has to be deliberate.
    expect(sightings("aura-shell/src/lib/place/boot.test.ts", argv)).not.toEqual([]);
  });
});

describe("the door and its doorway", () => {
  test("the door may spawn, and everything under it may too", () => {
    const src = 'pub async fn dial(m: &Machine) { Command::new("ssh").args(ssh_args(m)); }';
    expect(sideDoors(one(THE_DOOR, src))).toEqual([]);
    expect(sideDoors(one(`${THE_DOORWAY}script.rs`, src))).toEqual([]);
    expect(exemptionFor(`${THE_DOORWAY}anything/at/all.rs`)?.kind).toBe("door");
  });

  test("the dialer may name the program, because it is the seam", () => {
    expect(
      sideDoors(one(THE_DIALER, 'Shell { program: "ssh".into(), args: ssh_argv(m, &line, true) }')),
    ).toEqual([]);
  });

  test("a file one directory over from the door may not", () => {
    // The whole failure mode in one case: `cloudbox/mod.rs` is allowed and
    // `manager/brain/place_env.rs` is three lines from doing the same thing.
    const found = sideDoors(
      one(
        "aura-shell/src-tauri/src/manager/brain/place_env.rs",
        'Command::new("ssh").arg(m.host())',
      ),
    );
    expect(found.map((s) => s.rule)).toEqual(["spawns"]);
  });
});

describe("exemptions that stop being true", () => {
  test("a drawing of a command that grows a way to run one is reported", () => {
    const mock = EXEMPT.find((e) => e.kind === "mock")!;
    const grown = one(mock.path, "const argv = ['ssh', '-i', key];\nexecFile(argv[0], argv);");
    expect(unearnedExemptions(grown)).toEqual([
      `${mock.path} is exempt as something that only describes a command, but it can now run one`,
    ]);
  });

  test("a drawing that stayed a drawing is not", () => {
    const mock = EXEMPT.find((e) => e.kind === "mock")!;
    const still = one(mock.path, "const sshCommand = ['ssh', '-i', key].join(' ');");
    expect(unearnedExemptions(still)).toEqual([]);
  });

  test("an ops script something shipped now reaches is reported", () => {
    // The moment shipped code calls the script, the script is a transport with
    // a shell in the middle of it — and the exemption was for something else.
    const ops = EXEMPT.find((e) => e.kind === "ops")!;
    const found = unearnedExemptions([
      ...intact(),
      { path: ops.path, text: 'ssh -i "$KEY" "$HOST" uptime' },
      { path: "aura-shell/src-tauri/src/cmd_boot.rs", text: `run("${basename(ops.path)}")` },
    ]);
    expect(found).toEqual([
      `${ops.path} is exempt as an ops script nothing ships, but aura-shell/src-tauri/src/cmd_boot.rs reaches it`,
    ]);
  });

  test("another ops script mentioning it is two people at one laptop, not a transport", () => {
    const ops = EXEMPT.find((e) => e.kind === "ops")!;
    expect(
      unearnedExemptions([
        ...intact(),
        { path: ops.path, text: "ssh -i k h uptime" },
        { path: "scripts/release.sh", text: `bash ${basename(ops.path)}` },
      ]),
    ).toEqual([]);
  });

  test("a mock that was deleted is reported, so the list cannot outlive the file", () => {
    const mock = EXEMPT.find((e) => e.kind === "mock")!;
    expect(unearnedExemptions([])).toContain(
      `${mock.path} is exempt but no longer exists — drop the exemption`,
    );
  });
});
