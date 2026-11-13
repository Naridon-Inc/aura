// When macOS takes the window's renderer, the window comes back.
//
// WKWebView draws the page in a process of its own, and that process is near
// the top of the kernel's kill list: on a machine with no memory left it is
// SIGKILLed and `aura-shell` carries on behind a blank window. Nothing
// crashed, so nothing writes a report — the single trace is a `runningboardd`
// line reading `(19, 1, 9)` that ages out of the system log in two days. From
// the outside it is "Aura keeps crashing", and the only way out used to be
// quitting and relaunching.
//
// Three things have to hold for that to stay fixed, and all three revert
// quietly. The hook can be dropped while rearranging the builder chain and
// nothing fails to compile. The reload can be made unconditional by someone
// removing "pointless" backoff, which turns a memory-starved machine into a
// reload loop. And the toast can be retitled back to a flat "Aura closed
// unexpectedly", which is the sentence that sends the next reader hunting a
// crash that never happened.

import { describe, expect, it } from "bun:test";

import { readSrc } from "./support/code";

const recovery = await readSrc("../src-tauri/src/renderer_recovery.rs");
const lib = await readSrc("../src-tauri/src/lib.rs");
const crash = await readSrc("../src-tauri/src/crash.rs");
const toast = await readSrc("components/CrashRecoveryToast.tsx");

describe("the renderer-terminated hook", () => {
  it("is attached to the builder", () => {
    expect(lib).toContain(
      "on_web_content_process_terminate(renderer_recovery::on_renderer_terminated)",
    );
  });

  it("is attached under the cfg that the hook itself exists on", () => {
    // Tauri only defines it for macOS/iOS. Attaching it unguarded does not
    // fail here — it fails on the Linux and Windows legs, at release time.
    const at = lib.indexOf("on_web_content_process_terminate(");
    const guard = lib.lastIndexOf('#[cfg(any(target_os = "macos", target_os = "ios"))]', at);
    expect(guard).toBeGreaterThan(-1);
    // Immediately above it, not some unrelated cfg further up the file.
    expect(at - guard).toBeLessThan(400);
  });
});

describe("the recovery itself", () => {
  it("reloads the page", () => {
    expect(recovery).toContain("webview.reload()");
  });

  it("waits before reloading when the kernel keeps taking it", () => {
    expect(recovery).toContain("std::thread::sleep(delay)");
    // The first reclaim is instant — a one-off eviction should read as a
    // flicker, not as an outage.
    expect(recovery).toContain("Duration::ZERO,");
    // …and the gaps widen to a cap, so a machine that is genuinely out of
    // memory is not asked for the same allocation twice a second.
    expect(recovery).toContain("Duration::from_secs(30),");
  });

  it("does not block the main thread it is called on", () => {
    // The delegate callback that carries this event runs on the main thread.
    // Sleeping there is the same freeze the reclaim just caused.
    expect(recovery).toContain("std::thread::spawn");
    const spawn = recovery.indexOf("std::thread::spawn");
    expect(recovery.indexOf("std::thread::sleep(delay)")).toBeGreaterThan(spawn);
  });

  it("counts each webview's reclaims separately", () => {
    expect(recovery).toContain("HashMap<String, Tracker>");
    expect(recovery).toContain("map.entry(label.clone()).or_default()");
  });
});

describe("the record it leaves", () => {
  it("goes where the panics go, so one surface shows both", () => {
    expect(crash).toContain("fn record_renderer_reclaimed");
    expect(crash).toContain('const KIND_RENDERER_RECLAIMED: &str = "renderer_reclaimed"');
    // Same shape as a panic report: the launch toast and the list command
    // read `timestamp_ms` + `panic_message`, and a record that renames them
    // is a record nothing displays.
    expect(crash).toContain("panic_message: message.clone()");
    expect(crash).toContain("timestamp_ms,");
  });

  it("survives the full disk that usually comes with it", () => {
    // The same pressure that evicts a renderer is usually a machine with
    // nothing left anywhere, and a write that fails silently is why this
    // failure had no evidence to read in the first place.
    expect(crash).toContain("last_resort::note(");
  });

  it("reads an older record without a kind as a panic", () => {
    expect(crash).toContain("unwrap_or(KIND_PANIC)");
  });
});

describe("the toast", () => {
  it("titles itself by what actually happened", () => {
    expect(toast).toContain("function headline(kind: string)");
    expect(toast).toContain('kind === "renderer_reclaimed"');
    expect(toast).toContain("title={headline(top.kind)}");
  });

  it("no longer claims the app closed whatever the record says", () => {
    expect(toast).not.toContain('title="Aura closed unexpectedly"');
    // The honest one is still there for a real panic.
    expect(toast).toContain('"Aura closed unexpectedly"');
  });
});
