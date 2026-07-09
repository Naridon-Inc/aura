// Crash-proof native file/folder picker.
//
// `@tauri-apps/plugin-dialog`'s `open()` drives the macOS panel through rfd,
// which hard-crashes the whole app when `+[NSOpenPanel openPanel]` returns nil
// (it does when the panel is summoned while Aura isn't the foreground app — e.g.
// an autonomous agent triggers a folder pick while you're away):
//
//   unexpected NULL returned from +[NSOpenPanel openPanel]
//     … objc2-app-kit-0.3.2/src/generated/NSOpenPanel.rs:127:5
//
// On macOS we route through our own `dialog_pick` Rust command instead, which
// activates the app first, runs the panel on the main thread, and degrades a nil
// panel to a clean cancel rather than panicking (see src-tauri/cmd_dialog.rs).
// On every other platform we fall back to the plugin (the crash is macOS-only).
//
// `pickPath` returns the SAME shape as the plugin's `open` — `string` for a
// single selection, `string[]` when `multiple`, or `null` on cancel — so call
// sites swap one import for another with no behavior change.

import { invoke } from "@tauri-apps/api/core";

export type PickOptions = {
  /** Choose a directory instead of a file. */
  directory?: boolean;
  /** Allow selecting more than one entry. */
  multiple?: boolean;
  /** Optional prompt shown above the panel. */
  title?: string;
  /** Optional starting directory. */
  defaultPath?: string;
};

function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = navigator.platform || "";
  const ua = navigator.userAgent || "";
  return /Mac/i.test(p) || /Macintosh/i.test(ua);
}

/** Open a native file/folder picker. Crash-proof on macOS; plugin elsewhere. */
export async function pickPath(
  opts: PickOptions = {},
): Promise<string | string[] | null> {
  if (isMacOS()) {
    const paths = await invoke<string[]>("dialog_pick", {
      args: {
        directory: !!opts.directory,
        multiple: !!opts.multiple,
        title: opts.title ?? null,
        defaultPath: opts.defaultPath ?? null,
      },
    });
    if (!paths || paths.length === 0) return null;
    return opts.multiple ? paths : paths[0];
  }

  // Non-macOS: the plugin path is fine (the nil-panel crash is AppKit-specific).
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open({
    directory: opts.directory,
    multiple: opts.multiple,
    title: opts.title,
    defaultPath: opts.defaultPath,
  });
}
