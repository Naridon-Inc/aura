// Centralised app actions. The native menu emits `menu:<id>` events;
// browser keydowns dispatch the same ids. The host registers a
// dispatcher that maps each id → handler. Keeps shortcut behavior
// identical whether the user clicks a menu, presses a key, or types
// the matching slash command.

import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { routeEditUndo } from "./undoRouter";

export type AppActionId =
  | "palette"
  | "toggle_sidebar"
  | "toggle_terminal"
  | "toggle_review"
  | "reload_app"
  | "run_project"
  | "save"
  | "close_tab"
  | "settings"
  | "shortcuts"
  | "extensions"
  | "time_machine"
  | "project_timeline"
  | "open_aura"
  | "workspaces"
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

/** The menu items routed through `dispatch`. Fixed for the life of the
 *  window: the native menu is built once at startup, so this list is a
 *  constant and never a reason to re-subscribe.
 *
 *  NB: `check_for_updates` is intentionally NOT here — the native
 *  "Check for Updates…" item emits `menu:check_for_updates`, which
 *  UpdateBanner listens for directly (it owns the update flow + UI). */
const MENU_ACTION_IDS: AppActionId[] = [
  "palette",
  "toggle_sidebar",
  "toggle_terminal",
  "toggle_review",
  "run_project",
  "reload_app",
  "save",
  "close_tab",
  "settings",
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
  "open_aura",
];

export function useAppActions(dispatch: Dispatch) {
  // The handler changes on almost every render — `dispatchAction` in App
  // closes over the editor store — but WHAT we listen for never does.
  // Reading the handler through a ref keeps the two apart.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // Native menu → React. Each menu item the backend builds emits
  // `menu:<id>`; we forward to the app's dispatch.
  //
  // SUBSCRIBED ONCE, deliberately. Every `listen`/`unlisten` is a separate
  // cross-process IPC hop (Tauri v2 routes each one through a fetch to the
  // custom scheme handler), and there are 32 ids here. With `dispatch` in
  // the dependency array this effect tore down and re-registered on nearly
  // every render: measured at 363 listens + 359 unlistens in 15 seconds of
  // an IDLE app — 65% of all the IPC the app was doing, and every one of
  // them ahead of a keystroke in the same queue. That is what made typing
  // in the terminal feel behind.
  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = MENU_ACTION_IDS.map((id) =>
      listen(`menu:${id}`, () => dispatchRef.current(id)),
    );
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, []);

  // Edit ▸ Undo / Redo. Not in `MENU_ACTION_IDS` because the answer depends on
  // what has focus, not on app state — the router asks the registered editors.
  // This is the PRIMARY path on macOS: the menu's ⌘Z key equivalent is consumed
  // by NSMenu before the webview ever sees a keydown, so the in-app handler
  // below only fires where no native menu is in play.
  //
  // Nothing focused that owns an undo stack falls through to the engine's
  // undo-last-op, which is where plain ⌘Z went before this menu item existed.
  // Subscribed once, for the same IPC reason as the effect above.
  useEffect(() => {
    const unlisteners = [
      listen("menu:edit_undo", () => {
        if (!routeEditUndo("undo")) dispatchRef.current("aura_undo");
      }),
      listen("menu:edit_redo", () => void routeEditUndo("redo")),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, []);

  // In-app keymap — the only thing that runs the shortcuts on Linux and
  // Windows, and a second door to them on macOS. See `resolveShortcut`.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Bail before the parent-chain walk `isEditableTarget` costs — this
      // handler is on every keydown in the window, and all but a few of them
      // carry no modifier at all.
      if (!e.metaKey && !e.ctrlKey) return;
      const editable = isEditableTarget(e.target);
      // ⌘Z inside a text surface belongs to whichever editor has focus — a
      // question about live DOM focus, not about app state, so it cannot be
      // answered by the pure table below. A surface with no undo of its own
      // (xterm) is left alone rather than having the key swallowed.
      if (e.key.toLowerCase() === "z" && editable) {
        if (routeEditUndo(e.shiftKey ? "redo" : "undo")) e.preventDefault();
        return;
      }
      const id = resolveShortcut({
        key: e.key,
        meta: true,
        shift: e.shiftKey,
        alt: e.altKey,
        editable,
      });
      if (!id) return;
      e.preventDefault();
      dispatch(id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);
}

/** One keystroke, described without a DOM so it can be reasoned about (and
 *  tested) on its own. `meta` is ⌘ on macOS and Ctrl elsewhere — the two are
 *  the same key to every shortcut here. */
export type Chord = {
  key: string;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  /** Focus is in a text surface — input, textarea, contenteditable, xterm,
   *  CodeMirror or Monaco. A handful of chords stand down for it. */
  editable: boolean;
};

/**
 * The chord → action table. Returns null for anything we don't own, and the
 * caller preventDefault()s exactly when we do.
 *
 * THIS IS THE WHOLE SHORTCUT SURFACE OUTSIDE macOS. The native menubar only
 * exists on macOS (`src-tauri/src/menu.rs`, `install`) — everywhere else there
 * is no accelerator table in the window at all, so an item that lives only in
 * the menu is unreachable by keyboard on Linux and Windows. Every accelerator
 * menu.rs declares therefore has a twin below.
 *
 * On macOS the menu wins the race and this never sees those keys: AppKit
 * resolves menu key-equivalents in `performKeyEquivalent:`, ahead of the
 * responder chain, so ⌘S/⌘O/⌘K never reach the webview while the item exists.
 * That is why the overlap costs nothing — it is one path per platform, not two
 * firing at once.
 */
export function resolveShortcut(c: Chord): AppActionId | null {
  if (!c.meta) return null;
  switch (c.key.toLowerCase()) {
    case "k":
      return "palette";
    // ⌘B toggles the sidebar — but not while you're typing. Everywhere
    // else in computing ⌘B means bold, and we have three rich-text
    // surfaces (the notes editor, the manager composer, the PR review
    // box) that say so on their own toolbars. Without this guard the
    // sidebar collapsed instead.
    case "b":
      return c.editable ? null : "toggle_sidebar";
    case "j":
      return "toggle_terminal";
    // ⌘R runs the project — the key every IDE gives to "run this", and the
    // one the agent working in this window is changing the code of. Reload
    // moves to ⌘⇧R and is dispatched rather than left to the webview: the
    // app's own recovery key should not depend on a shortcut we don't
    // install. ⌘⌥R keeps the Review-panel toggle.
    case "r":
      if (c.shift) return "reload_app";
      if (c.alt) return "toggle_review";
      return "run_project";
    // ⌘W closes the tab; ⌘⇧W opens Workspaces — the full view of every
    // parallel copy. Shift has to branch here rather than get its own
    // handler elsewhere, because this case fired on ⌘⇧W too and silently
    // closed the user's tab.
    case "w":
      return c.shift ? "workspaces" : "close_tab";
    // ⌘S saves the open file. Plain only: Monaco owns ⌘⇧S ("Share to chat…",
    // MonacoEditor.tsx) and would lose it to a preventDefault here.
    case "s":
      return c.shift || c.alt ? null : "save";
    // ⌘O opens a project folder — the one File-menu item with no command
    // palette entry, so without this row there is no way to reach it by
    // keyboard where the menubar isn't drawn.
    case "o":
      return c.shift || c.alt ? null : "open_file";
    // ⌘⇧I — Log Intent. Shift required (⌘I is italic in the rich-text
    // surfaces), matching the accelerator the Engine menu carries.
    case "i":
      return c.shift ? "aura_log_intent" : null;
    // ⌘+ / ⌘= zoom in. Most US keyboards send "=" without shift and
    // "+" with shift; accept both so the user doesn't have to think.
    case "+":
    case "=":
      return "zoom_in";
    case "-":
    case "_":
      return "zoom_out";
    case "0":
      return "zoom_reset";
    // ⌘⇧A — Ask Aura. Shift required so we don't conflict with
    // ⌘A "Select All" inside text fields.
    case "a":
      return c.shift ? "aura_ask" : null;
    // ⌘⇧P — Plan Builder. Shift required so we don't conflict with
    // ⌘P "Quick open file" pattern.
    case "p":
      return c.shift ? "plan_builder" : null;
    // ⌘, — Settings. macOS-conventional, matches every native app.
    case ",":
      return "settings";
    // ⌘Z — undo last engine op (jj-style). Only answers when focus is OUTSIDE
    // an editable surface; inside one the caller routes to whichever editor
    // owns the undo stack (`undoRouter`), which is a question about live DOM
    // focus and so cannot be decided in this pure table.
    case "z":
      if (c.shift) return null; // ⌘⇧Z = redo, leave alone
      return c.editable ? null : "aura_undo";
    default:
      return null;
  }
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
