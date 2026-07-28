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
  | "reload_app"
  | "save"
  | "close_tab"
  | "settings"
  | "shortcuts"
  | "extensions"
  | "time_machine"
  | "project_timeline"
  | "workspaces"
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
  | "open_prs"
  | "mobile_waitlist";

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
      "reload_app",
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
          if (e.shiftKey) return; // ⌘⇧R = browser hard-reload, leave native alone
          e.preventDefault();
          // Plain ⌘R reloads the app (the refresh people reach for when HMR
          // wedges the UI); ⌘⌥R keeps the old Review-panel toggle.
          dispatch(e.altKey ? "toggle_review" : "reload_app");
          break;
        // ⌘W closes the tab; ⌘⇧W opens Workspaces — the full view of every
        // parallel copy. Shift has to branch here rather than get its own
        // handler elsewhere, because this case fired on ⌘⇧W too and silently
        // closed the user's tab.
        case "w":
          e.preventDefault();
          dispatch(e.shiftKey ? "workspaces" : "close_tab");
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

// Treats input / textarea / contenteditable / CodeMirror / Monaco / xterm
// surfaces as "editor focus" so ⌘Z stays out of the way of native
// text undo. Walks the parent chain because the actual focus target
// may be an inner span.
//
// Monaco needs explicit handling: on WKWebView it drives input through an
// EditContext surface (`div.native-edit-context`) — not an INPUT/TEXTAREA and
// not contentEditable — so without these class checks the global ⌘Z would
// hijack the file editor's undo and open the engine OpLog instead.
const EDITOR_SURFACE_CLASSES = [
  "cm-editor", // CodeMirror
  "xterm", // terminal
  "monaco-editor", // Monaco file editor
  "native-edit-context", // Monaco EditContext input node
  "inputarea", // Monaco legacy textarea fallback
];

function isEditableTarget(target: EventTarget | null): boolean {
  let el = target as HTMLElement | null;
  while (el) {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    if (el.classList && EDITOR_SURFACE_CLASSES.some((c) => el!.classList.contains(c))) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}
