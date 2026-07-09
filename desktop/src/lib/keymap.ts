// Centralised app actions. The native menu emits `menu:<id>` events;
// browser keydowns dispatch the same ids. The host registers a
// dispatcher that maps each id → handler. Keeps shortcut behavior
// identical whether the user clicks a menu, presses a key, or types
// the matching slash command.

import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

export type AppActionId =
  | "palette"
  | "toggle_sidebar"
  | "toggle_terminal"
  | "toggle_review"
  | "save"
  | "close_tab"
  | "settings"
  | "extensions"
  | "time_machine"
  | "project_timeline"
  | "new_file"
  | "open_file"
  | "zoom_in"
  | "zoom_out"
  | "zoom_reset"
  | "aura_status"
  | "aura_doctor"
  | "aura_impacts"
  | "aura_snapshot"
  | "aura_rewind"
  | "aura_log_intent"
  | "aura_handover"
  | "aura_pr_review"
  | "aura_prove"
  | "aura_ask"
  | "aura_undo"
  | "plan_builder"
  | "orchestrate"
  | "tasks_board"
  | "notes"
  | "open_prs";

export type Dispatch = (id: AppActionId) => void;

export function useAppActions(dispatch: Dispatch) {
  // Native menu → React. Each menu item the backend builds emits
  // `menu:<id>`; we forward to the app's dispatch.
  useEffect(() => {
    const ids: AppActionId[] = [
      "palette",
      "toggle_sidebar",
      "toggle_terminal",
      "toggle_review",
      "save",
      "close_tab",
      "settings",
      "new_file",
      "open_file",
      "zoom_in",
      "zoom_out",
      "zoom_reset",
      "aura_status",
      "aura_doctor",
      "aura_impacts",
      "aura_snapshot",
      "aura_rewind",
      "aura_log_intent",
      "aura_handover",
      "aura_pr_review",
      "aura_prove",
      "aura_ask",
      "aura_undo",
      "plan_builder",
      "orchestrate",
      "tasks_board",
      "notes",
      "open_prs",
      "extensions",
      "time_machine",
      "project_timeline",
    ];
    // NB: `check_for_updates` is intentionally NOT routed here — the native
    // "Check for Updates…" item emits `menu:check_for_updates`, which
    // UpdateBanner listens for directly (it owns the update flow + UI).
    const unlisteners: Array<Promise<() => void>> = ids.map((id) =>
      listen(`menu:${id}`, () => dispatch(id)),
    );
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [dispatch]);

  // In-app keymap — a thin layer on top of menu accelerators so the
  // shortcuts also fire when the menubar isn't focused (and on Linux
  // / Windows where the native menu may be hidden).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      switch (k) {
        case "k":
          e.preventDefault();
          dispatch("palette");
          break;
        case "b":
          e.preventDefault();
          dispatch("toggle_sidebar");
          break;
        case "j":
          e.preventDefault();
          dispatch("toggle_terminal");
          break;
        case "r":
          if (e.shiftKey) return; // leave native reload alone in dev
          e.preventDefault();
          dispatch("toggle_review");
          break;
        case "w":
          e.preventDefault();
          dispatch("close_tab");
          break;
        // ⌘+ / ⌘= zoom in. Most US keyboards send "=" without shift and
        // "+" with shift; accept both so the user doesn't have to think.
        case "+":
        case "=":
          e.preventDefault();
          dispatch("zoom_in");
          break;
        case "-":
        case "_":
          e.preventDefault();
          dispatch("zoom_out");
          break;
        case "0":
          e.preventDefault();
          dispatch("zoom_reset");
          break;
        // ⌘⇧A — Ask Aura. Shift required so we don't conflict with
        // ⌘A "Select All" inside text fields.
        case "a":
          if (e.shiftKey) {
            e.preventDefault();
            dispatch("aura_ask");
          }
          break;
        // ⌘⇧P — Plan Builder. Shift required so we don't conflict with
        // ⌘P "Quick open file" pattern.
        case "p":
          if (e.shiftKey) {
            e.preventDefault();
            dispatch("plan_builder");
          }
          break;
        // ⌘, — Settings. macOS-conventional, matches every native app.
        case ",":
          e.preventDefault();
          dispatch("settings");
          break;
        // ⌘Z — undo last engine op (jj-style). Only fires when focus
        // is OUTSIDE an editable surface so we don't hijack normal
        // text-input undo (CodeMirror, terminal xterm, <input>, etc.).
        case "z":
          if (e.shiftKey) return; // ⌘⇧Z = redo, leave alone
          if (isEditableTarget(e.target)) return;
          e.preventDefault();
          dispatch("aura_undo");
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);
}

// Treats input / textarea / contenteditable / CodeMirror / xterm
// surfaces as "editor focus" so ⌘Z stays out of the way of native
// text undo. Walks the parent chain because the actual focus target
// may be an inner span.
function isEditableTarget(target: EventTarget | null): boolean {
  let el = target as HTMLElement | null;
  while (el) {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    if (el.classList && (el.classList.contains("cm-editor") || el.classList.contains("xterm"))) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}
