// The footer's `aura` version chip, driven in a real window.
//
//   bun test
//
// WHAT IT WAS SAYING. On this machine the chip sat amber in the status bar
// reading `aura 0.4.6-alpha → 0.19.35`, with an "Update to 0.19.35" button
// under it. Every number in that sentence was about `/usr/local/bin/aura` —
// a two-year-old binary the app had already decided not to run. Task #160
// taught the app to step over a stale PATH entry (`pick_runnable_aura`
// picks the first candidate whose version is current); the chip never got
// the message and kept calling `resolve_aura_path`, which is a plain
// `which aura`. So the one surface whose entire job is "which aura is
// this" was naming the wrong binary, reporting its version as the app's,
// and offering to fix a problem that wasn't the app's problem.
//
// TWO BINARIES, TWO TRUTHS. Both facts are worth saying, and they are not
// the same fact:
//
//   - the app runs 0.19.35 and is fine       → nothing is broken here
//   - your terminal types `aura` and gets    → this one IS worth telling
//     0.4.6-alpha                              you, and only you can fix it
//
// So `shadowing` is its own field, not a variant of "outdated", and the
// chip renders on it even when `status === "ok"`. It is also NOT a
// permanent relabelled nag: with the current binary first on PATH the chip
// disappears entirely.
//
// AND THE TOAST STAYS QUIET. Replacing the shadowing copy means a macOS
// admin-password prompt. Asking for one unprompted at launch, to fix
// something that is not stopping anything, is exactly the nag the toast
// exists to avoid — so the shadow case is the chip's to carry, silently.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const BAR = "components/StatusBar.tsx";
const TOAST = "components/CliUpdateToast.tsx";
const API = "lib/api.ts";
const TAURI = "../src-tauri/src/cmd_doctor_cli.rs";

/** The `aura_cli_version_check` body. */
async function checkFn(): Promise<string> {
  const rs = await readSrc(TAURI);
  const from = rs.indexOf("pub async fn aura_cli_version_check(");
  return rs.slice(from, rs.indexOf("\n}\n", from));
}

/** The `CliVersionChip` component body. */
async function chip(): Promise<string> {
  const src = await readSrc(BAR);
  return src.slice(src.indexOf("function CliVersionChip("));
}

describe("the chip reports the binary the app runs", () => {
  test("it asks the version-aware resolver, not `which aura`", async () => {
    const fn = await checkFn();
    expect(fn).toContain("let path = resolve_runnable_aura();");
    // The old call is gone from this function entirely — `shadowing_cli`
    // is now the only place a bare PATH lookup is allowed to matter.
    expect(fn).not.toContain("resolve_aura_path()");
  });

  test("`missing` means no aura anywhere, not no aura on PATH", async () => {
    const fn = await checkFn();
    // `pick_runnable_aura` degrades to the bare binary name when it finds
    // nothing on disk AND nothing on PATH. That — not a failed `which` —
    // is the case that earns "missing".
    expect(fn).toContain("if !Path::new(&path).is_absolute() {");
    expect(fn).toContain('status: "missing".into()');
  });

  test("every answer it can return carries the shadow field", async () => {
    const fn = await checkFn();
    // Three constructions: missing, spawn-failed, and the real one. A
    // fourth added without `shadowing` would not compile, but a fourth
    // that hardcodes `None` would — and would silently drop the chip.
    expect(fn.split("AuraCliVersionCheck {").length - 1).toBe(3);
    expect(fn).toContain("shadowing: None,"); // missing: nothing resolved
    // Plus the spawn-failed answer and the real one, which both pass the
    // computed value through.
    expect(fn.split("shadowing,").length - 1).toBe(2);
  });
});

describe("a shadow is only reported on evidence", () => {
  test("same binary is not a shadow of itself", async () => {
    const rs = await readSrc(TAURI);
    const fn = rs.slice(
      rs.indexOf("fn shadowing_cli("),
      rs.indexOf("pub async fn aura_cli_version_check("),
    );
    expect(fn).toContain("if path == running {");
    expect(fn).toContain("return None;");
  });

  test("a version we can't read is not called stale", async () => {
    const rs = await readSrc(TAURI);
    const fn = rs.slice(rs.indexOf("fn shadowing_cli("));
    // `?` on the read: a wrapper script that answers `--version` with
    // something unparseable is a legitimate setup, and "can't read it"
    // is not evidence of anything.
    expect(fn).toContain("let installed = installed_version_of(&path)?;");
    // And a PATH copy that IS current is no shadow either.
    expect(fn).toContain(
      "if major_minor_at_least(&installed, EXPECTED_AURA_CLI_VERSION) {",
    );
  });
});

describe("the chip renders on the shadow, and only says so once", () => {
  test("visibility includes it alongside outdated and missing", async () => {
    const src = await readSrc(BAR);
    const gate = src.slice(
      src.indexOf("{cliVersion &&"),
      src.indexOf("<CliVersionChip"),
    );
    expect(gate).toContain('cliVersion.status === "outdated"');
    expect(gate).toContain('cliVersion.status === "missing"');
    expect(gate).toContain("cliVersion.shadowing");
  });

  test("the shadow is its own state, not a flavour of outdated", async () => {
    const body = await chip();
    // `status` stays "ok" in this case — nothing about the app is stale.
    expect(body).toContain(
      'const shadowed = info.status === "ok" && info.shadowing !== null;',
    );
  });

  test("it goes amber and says which aura is the old one", async () => {
    const body = await chip();
    expect(body).toContain('info.status === "outdated" || shadowed');
    expect(body).toContain('shadowed\n    ? "old aura on PATH"');
    // The tooltip names both binaries — that's the whole point.
    expect(body).toContain("Aura runs ${info.installed} from ${info.path}");
    expect(body).toContain(
      "A terminal finds ${info.shadowing?.installed} at ${info.shadowing?.path} first",
    );
  });

  test("the popover prints the shadow state over the raw status", async () => {
    const body = await chip();
    expect(body).toContain('{shadowed ? "old copy on your PATH" : info.status}');
    // "Aura uses", not "Installed": with two binaries in play, "installed"
    // no longer identifies anything.
    expect(body).toContain("Aura uses");
    // And the other copy gets a row of its own.
    expect(body).toContain("{info.shadowing && (");
    expect(body).toContain("{info.shadowing.installed} · {info.shadowing.path}");
  });

  test("the fix is offered in the user's words, not the app's", async () => {
    const body = await chip();
    expect(body).toContain('info.status === "outdated" ||\n            info.status === "missing" ||\n            shadowed');
    expect(body).toContain("Aura is fine — it runs the newer one.");
    expect(body).toContain("type yourself gets the old copy.");
    expect(body).toContain("Replace the old copy with ${info.expected}");
  });
});

describe("the launch toast stays out of it", () => {
  test("it still bails on ok, which is what the shadow case is", async () => {
    const src = await readSrc(TOAST);
    expect(src).toContain(
      'if (!live() || check.status === "ok" || check.status === "unknown") {',
    );
    // No shadow-specific escape hatch snuck in below the bail.
    expect(src.slice(src.indexOf("if (!live() ||"))).not.toContain("shadowing");
  });
});

describe("one shape, one source", () => {
  test("the check type is exported once and shared", async () => {
    const src = await readSrc(API);
    expect(src).toContain("export type AuraCliCheck = {");
    expect(src).toContain("export type ShadowedCli = {");
    expect(src).toContain("shadowing: ShadowedCli | null;");
    // Both invokes speak the shared type — they used to inline it.
    expect(
      src.split('invoke<AuraCliCheck>("aura_cli_').length - 1,
    ).toBe(2);
  });

  test("its consumers import it instead of re-declaring it", async () => {
    const bar = await readSrc(BAR);
    const toast = await readSrc(TOAST);
    const app = await readSrc("App.tsx");
    expect(bar).toContain("type AuraCliCheck");
    expect(bar).toContain("cliVersion?: AuraCliCheck | null;");
    expect(toast).toContain("type CliCheck = AuraCliCheck;");
    expect(app).toContain("useState<AuraCliCheck | null>(null)");
    // The four hand-copied literal shapes are gone.
    for (const src of [bar, toast, app]) {
      expect(src).not.toContain('status: "ok" | "outdated"');
    }
  });
});
