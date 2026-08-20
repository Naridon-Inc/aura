// The smart-merge row tells the truth and hands you a live control.
//
//   bun test
//
// Driven in a real window, Settings > Repository > Record changes said:
//
//     aura CLI is too old. Update it to manage merges here      [ Install ]
//
// with Install greyed out. Two problems in one row. "Too old" was asserted
// for EVERY non-zero exit — nothing had checked a version — and the only
// control was dead, so a message that begins "update it" gave you nothing
// to press.
//
// Shown the real stderr, the machine answered in one line:
//
//     error: unrecognized subcommand 'merge-driver'
//
// A 0.4.6-alpha binary in /usr/local/bin was shadowing the current CLI in
// ~/.cargo/bin. The row now says which of those two things went wrong, and
// when it is the CLI the button installs the one this release ships with.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const SRC = "components/dialogs/SettingsDialog.tsx";

describe("smart merge row", () => {
  test("a failed probe keeps what the CLI actually said", async () => {
    const src = await readSrc(SRC);
    expect(src).toContain("setMergeProbeDetail");
    // stderr first — a clap usage error goes there, and it is the line that
    // named the shadowed binary.
    expect(src).toContain("(res.stderr || res.stdout || \"\").trim()");
    // Never silently blank: an exit code is still an answer.
    expect(src).toContain("`aura merge-driver exited ${res.status}`");
    // And it reaches the screen, not just state.
    expect(src).toContain("{mergeProbeDetail}");
  });

  test('"too old" is checked, not assumed', async () => {
    const src = await readSrc(SRC);
    expect(src).toContain('(await api.auraCliVersionCheck()).status === "outdated"');
    // The old string asserted a cause for every failure. It is gone.
    expect(src).not.toContain("aura CLI is too old. Update it to manage merges here");
    // Two different headlines for two different situations.
    expect(src).toContain(
      "The aura command on this computer is too old for smart merge",
    );
    expect(src).toContain("Couldn't read the smart-merge setting");
  });

  test("every branch of the row offers something to press", async () => {
    const src = await readSrc(SRC);
    // Outdated CLI: the app can repair this itself.
    expect(src).toContain("Update aura");
    expect(src).toContain("api.auraCliInstallBundled(true)");
    // Any other failure: re-probe, because whatever the detail line names is
    // something the user fixes outside the app.
    expect(src).toContain("Try again");
    // The dead-button condition is gone — Install/Uninstall is now only
    // rendered when the probe actually succeeded.
    expect(src).not.toContain("disabled={mergeBusy || mergeUnavailable !== null}");
  });
});
