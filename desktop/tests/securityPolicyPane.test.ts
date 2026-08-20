// Settings → Repository → Security & policy, driven in a real window.
//
//   bun test
//
// Two things on this pane were the wrong way round.
//
// STRICT MODE. The row read:
//
//     Status  off
//     Strict mode is off. Turn it on (with a passcode, recommended) so Aura
//     stops any commit where the AI deletes working code or strays from what
//     it promised: run `aura config set strict-mode true`
//
// Turning the guard OFF was a button in this row. Turning it ON was a command
// you had to go and type somewhere else — which also refuses outside an
// interactive TTY and demands a passcode, so "(recommended)" described
// something that wasn't optional. On the setting the whole product is about,
// removing the protection was one click and adding it was a terminal.
//
// The shell can enable now. It deliberately cannot lock: a passcode chosen
// over the IPC bridge is a passcode an agent could have chosen, and the lock
// exists so that nothing on this machine can undo it.
//
// RULE TEMPLATE LIBRARY. Seven packs, each with an `install` button that
// became `re-install` once clicked. Both claims came from a Set in React
// state seeded empty — a repo with every pack already merged showed seven
// `install` buttons, and closing Settings forgot what you'd just done. And
// `re-install` wasn't idempotent: `add_policy_pack` deduped three of its four
// rule lists and appended `layer_rules` unconditionally, so the button the
// pane offered grew production.aura.json every click.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const PANE = "components/dialogs/SettingsDialog.tsx";
const API = "lib/api.ts";
const CLI = "../../aura-cli/src/pr.rs";
const TAURI = "../src-tauri/src/cmd_settings.rs";
const HANDLER = "../src-tauri/src/lib.rs";

describe("strict mode — the protective direction is the easy one", () => {
  test("there is a command that turns the guard on", async () => {
    const src = await readSrc(TAURI);
    expect(src).toContain("pub async fn settings_enable_strict_unlocked()");
    expect(src).toContain(
      'map.insert("strict_gatekeeper_mode".into(), serde_json::Value::Bool(true))',
    );
  });

  test("and it cannot lock — that still needs a human at a terminal", async () => {
    const src = await readSrc(TAURI);
    const fn = src.slice(
      src.indexOf("pub async fn settings_enable_strict_unlocked()"),
      src.indexOf("pub async fn settings_disable_strict_unlocked()"),
    );
    // Never writes the hash the lock is made of, so an agent can switch the
    // guard on but can't choose the passcode that makes it un-switchable.
    expect(fn).not.toContain("strict_mode_passcode_hash");
  });

  test("it's registered, and reachable from the renderer", async () => {
    expect(await readSrc(HANDLER)).toContain(
      "cmd_settings::settings_enable_strict_unlocked",
    );
    expect(await readSrc(API)).toContain(
      'invoke<void>("settings_enable_strict_unlocked")',
    );
  });

  test("the row offers Turn on when it's off", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("await api.settingsEnableStrictUnlocked()");
    expect(src).toContain("{!strict && !locked && (");
    expect(src).toContain("Turn on");
  });

  test("and stops calling a mandatory passcode optional", async () => {
    const src = await readSrc(PANE);
    expect(src).not.toContain("(with a passcode, recommended)");
    // The CLI line stays, for the one thing the app can't do.
    expect(src).toContain("To also lock it");
  });
});

describe("rule packs — the library knows what this repo already has", () => {
  test("a pack reports whether it's installed", async () => {
    const rs = await readSrc(CLI);
    expect(rs).toContain("pub installed: bool");
    expect(rs).toContain("installed: p.rules.contained_in(&current)");
  });

  test("installed means all of it, not any of it", async () => {
    const rs = await readSrc(CLI);
    const fn = rs.slice(
      rs.indexOf("fn contained_in(&self"),
      rs.indexOf("struct Pack {"),
    );
    // security and owasp both ban `eval`; any-overlap would mark owasp
    // installed the moment security was.
    expect(fn).toContain(".all(|s| rules.forbidden_imports.iter().any");
    expect(fn).not.toContain(".any(|s| rules.forbidden_imports");
  });

  test("layer rules are deduped like everything beside them", async () => {
    const rs = await readSrc(CLI);
    expect(rs).toContain("rules.layer_rules.sort();");
    expect(rs).toContain("rules.layer_rules.dedup();");
    expect(rs).toContain("fn merge_pack(rules: &mut InvariantRules");
  });

  test("the pane reads that flag instead of remembering clicks", async () => {
    const src = await readSrc(PANE);
    const sect = src.slice(src.indexOf("function TemplatesSection("));
    expect(sect).not.toContain("useState<Set<string>>(new Set())");
    expect(sect).not.toContain("re-install");
    expect(sect).toContain("{p.installed ? (");
    // A fresh read after a successful add, because the file is the authority.
    expect(sect).toContain("await load();");
  });

  test("a failed load stops the spinner instead of running it forever", async () => {
    const src = await readSrc(PANE);
    const sect = src.slice(
      src.indexOf("function TemplatesSection("),
      src.indexOf("function TelemetryTab("),
    );
    expect(sect.split("setPacks([]);").length - 1).toBe(2);
  });
});
