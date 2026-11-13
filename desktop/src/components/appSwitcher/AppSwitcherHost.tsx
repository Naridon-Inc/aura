// The app switcher's keys and its opening. ⌥⌘O (routed here from App.tsx
// through `stepAppSwitcher`) opens it on the app you used last, or steps to
// the next one while it is open; ⇧ steps back. Letting go of ⌘ or ⌥ opens the
// workspace's folder in the selected app, the Close tile or Esc puts it away
// without opening anything, and so does the window losing focus.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { api, type EditorInfo } from "../../lib/api";
import {
  CLOSE_TILE,
  FILE_MANAGER,
  appSwitcher,
  fileManagerName,
  readRecent,
  recordUse,
  releasesSwitcher,
  switcherEntries,
  useAppSwitcher,
  writeRecent,
} from "../../lib/appSwitcher";
import { toast } from "../../lib/toast";
import { AppSwitcher } from "../ui/app-switcher";

// What this computer can open a folder in. Asked for when the host mounts and
// again on every opening, so an editor installed meanwhile shows up next time.
let apps: EditorInfo[] = [];
let icons: Record<string, string> = {};
let asking: Promise<void> | null = null;
const iconWatchers = new Set<(next: Record<string, string>) => void>();

function askForApps(): Promise<void> {
  if (asking) return asking;
  const wantIcons = Object.keys(icons).length === 0;
  asking = Promise.all([
    api.editorsList().then(
      (list) => {
        apps = list;
      },
      () => {},
    ),
    wantIcons
      ? api.editorsIcons().then(
          (map) => {
            icons = map;
            for (const fn of iconWatchers) fn(map);
          },
          () => {},
        )
      : undefined,
  ]).then(
    () => {
      asking = null;
    },
    () => {
      asking = null;
    },
  );
  return asking;
}

/** ⌥⌘O (step 1) or ⌥⌘⇧O (step -1). `path` is the folder to open, null when
 *  the workspace in front has none on this computer. */
export function stepAppSwitcher(path: string | null, step: 1 | -1): void {
  if (appSwitcher.get().active) {
    if (step > 0) appSwitcher.forward();
    else appSwitcher.backward();
    return;
  }
  if (step < 0) return;
  if (!path) {
    toast.warning("Nothing to open in an app", "This workspace has no folder on this computer.");
    return;
  }
  const entries = switcherEntries(apps, readRecent(), window.innerWidth, fileManagerName(navigator.userAgent));
  appSwitcher.activate(entries, path);
  void askForApps();
}

function openChosen(): void {
  const { path } = appSwitcher.get();
  const entry = appSwitcher.selectedEntry();
  appSwitcher.deactivate();
  if (!entry || entry.id === CLOSE_TILE || !path) return;
  writeRecent(recordUse(readRecent(), entry.id));
  // The file manager is the OS default for a folder.
  const editorId = entry.id === FILE_MANAGER ? "default" : entry.id;
  api.editorOpen(path, editorId).catch((e) => toast.danger(`Couldn't open in ${entry.name}`, String(e)));
}

export function AppSwitcherHost() {
  const state = useAppSwitcher();
  const [iconMap, setIconMap] = useState(icons);

  useEffect(() => {
    iconWatchers.add(setIconMap);
    void askForApps();
    return () => {
      iconWatchers.delete(setIconMap);
    };
  }, []);

  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (appSwitcher.get().active && releasesSwitcher(e)) openChosen();
    };
    // Esc is taken before anything under the panel sees it: a dialog behind
    // the switcher should not close along with it.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!appSwitcher.get().active || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      appSwitcher.deactivate();
    };
    const onBlur = () => appSwitcher.deactivate();
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  if (!state.active) return null;
  return createPortal(
    <AppSwitcher
      entries={state.entries}
      selected={state.selected}
      visible={state.ready}
      icons={iconMap}
      onSelect={appSwitcher.select}
      onOpen={(i) => {
        appSwitcher.select(i);
        openChosen();
      }}
      onCancel={appSwitcher.deactivate}
    />,
    document.body,
  );
}
