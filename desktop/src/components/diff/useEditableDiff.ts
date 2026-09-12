// useEditableDiff — the save-and-stay-honest half of an editable diff.
//
// A diff pane that can be typed into has three jobs beyond rendering:
//
//  1. Know when the buffer differs from what is on disk (the unsaved dot).
//  2. Save on ⌘S — registered on the Monaco editor instance itself, so the
//     shortcut only fires while the diff has focus and never as a global chord.
//  3. Never clobber typing. The host re-reads the file after every refresh and
//     every save, and `@monaco-editor/react` replaces the modified buffer the
//     moment its `modified` prop changes. So this hook holds that prop STILL
//     while there are unsaved edits, and when the file moves on disk underneath
//     them it says "Changed on disk" and offers Reload instead of overwriting.
//
// One hook, two hosts: the Changes pane (whole working-tree file read from
// disk) and the editor-tab diff (the editor's own buffer). Neither needs to
// know about Monaco commands or fs events.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { listen } from "@tauri-apps/api/event";

import { api } from "../../lib/api";

export type EditableDiffHandle = {
  /** Text the modified pane is seeded with. Held still while there are unsaved
   *  edits so a host re-read can never overwrite typing; moves to the newest
   *  disk text the moment the buffer is clean again, or on `reload`. */
  modified: string;
  /** The buffer differs from the last text loaded from disk. */
  dirty: boolean;
  saving: boolean;
  /** The file changed on disk while there were unsaved edits. The buffer is
   *  untouched; `reload` drops the edits and takes the disk version. */
  diskChanged: boolean;
  /** Plain-language reason the last save failed, or null. */
  error: string | null;
  /** Wire up a mounted DiffEditor: dirty tracking + ⌘S on its modified side. */
  attach: (instance: editor.IStandaloneDiffEditor, monaco: Monaco) => void;
  /** Write the buffer to disk. A no-op when clean. */
  save: () => Promise<void>;
  /** Drop unsaved edits and take the disk version. */
  reload: () => void;
};

export function useEditableDiff({
  absPath,
  diskText,
  onSaved,
  onDiskChanged,
}: {
  /** Absolute path of the file the modified side is. Null when there is no
   *  file to save to (a deleted file, nothing selected). */
  absPath: string | null;
  /** The host's latest read of the file. Null while it has none. */
  diskText: string | null;
  /** After a successful write — the host refreshes its diff from disk. */
  onSaved?: () => void;
  /** The file changed on disk and there were NO unsaved edits — the host
   *  should re-read so the pane follows. */
  onDiskChanged?: () => void;
}): EditableDiffHandle {
  const [loaded, setLoadedState] = useState<string>(diskText ?? "");
  const [dirty, setDirtyState] = useState(false);
  const [saving, setSaving] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs mirror the state that Monaco's listeners and the ⌘S handler read —
  // those callbacks are registered once on mount and must see live values.
  const loadedRef = useRef(loaded);
  const dirtyRef = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const pathRef = useRef(absPath);
  const diskTextRef = useRef(diskText);
  diskTextRef.current = diskText;
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const onSavedRef = useRef(onSaved);
  const onDiskChangedRef = useRef(onDiskChanged);
  onSavedRef.current = onSaved;
  onDiskChangedRef.current = onDiskChanged;

  const setLoaded = useCallback((text: string) => {
    loadedRef.current = text;
    setLoadedState(text);
  }, []);
  const setDirty = useCallback((d: boolean) => {
    if (dirtyRef.current === d) return;
    dirtyRef.current = d;
    setDirtyState(d);
  }, []);

  // A different file is a fresh start: no edits carry across, no stale
  // "changed on disk" from the previous one.
  useEffect(() => {
    if (pathRef.current === absPath) return;
    pathRef.current = absPath;
    pendingRef.current = null;
    setDirty(false);
    setDiskChanged(false);
    setError(null);
    setLoaded(diskTextRef.current ?? "");
  }, [absPath, setDirty, setLoaded]);

  // The host re-read the file. Clean buffer → follow it. Unsaved edits → keep
  // them, remember the disk text for Reload, and say so.
  useEffect(() => {
    if (diskText == null) return;
    if (diskText === loadedRef.current) {
      pendingRef.current = null;
      setDiskChanged(false);
      return;
    }
    if (!dirtyRef.current) {
      setLoaded(diskText);
      pendingRef.current = null;
      setDiskChanged(false);
      return;
    }
    pendingRef.current = diskText;
    setDiskChanged(true);
  }, [diskText, setLoaded]);

  const save = useCallback(async () => {
    const path = pathRef.current;
    const ed = editorRef.current;
    if (!path || !ed) return;
    const model = ed.getModel()?.modified;
    if (!model) return;
    const text = model.getValue();
    if (text === loadedRef.current) return;
    setSaving(true);
    setError(null);
    try {
      await api.writeFile(path, text);
      // What we wrote is now what is on disk: the buffer is clean against it,
      // and any disk change we were holding is superseded by our own write.
      setLoaded(text);
      pendingRef.current = null;
      setDiskChanged(false);
      setDirty(false);
      onSavedRef.current?.();
      // Every git surface listens for this one signal (status bar, Changes
      // tab, file diff pane) — a save changes what git sees.
      window.dispatchEvent(new CustomEvent("aura:git-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [setDirty, setLoaded]);
  const saveRef = useRef(save);
  saveRef.current = save;

  const reload = useCallback(() => {
    const next = pendingRef.current;
    pendingRef.current = null;
    setDiskChanged(false);
    setError(null);
    if (next == null) return;
    // Seeding the prop is what replaces the buffer (the DiffEditor wrapper
    // applies it); marking clean now keeps the dot from flickering meanwhile.
    setDirty(false);
    setLoaded(next);
  }, [setDirty, setLoaded]);

  const attach = useCallback(
    (instance: editor.IStandaloneDiffEditor, monaco: Monaco) => {
      editorRef.current = instance;
      const mod = instance.getModifiedEditor();
      mod.onDidChangeModelContent(() => {
        setDirty(mod.getValue() !== loadedRef.current);
      });
      // Scoped to this editor: fires only while the modified side has focus.
      // Monaco stops the keydown once a binding handles it, so the window's
      // own ⌘S (save the active editor tab) never also runs.
      mod.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void saveRef.current();
      });
    },
    [setDirty],
  );

  // The workspace watcher reports every file that changes on disk. For this
  // file: with unsaved edits, fetch the new disk text so Reload has it; when
  // clean, let the host re-read and follow along.
  useEffect(() => {
    if (!absPath) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    listen<{ path: string; kind: string }>("fs:changed", (ev) => {
      if (!alive || ev.payload?.path !== absPath) return;
      if (!dirtyRef.current) {
        onDiskChangedRef.current?.();
        return;
      }
      api
        .readFile(absPath)
        .then((content) => {
          if (!alive || content.status !== "ok") return;
          if (content.text === loadedRef.current) return;
          pendingRef.current = content.text;
          setDiskChanged(true);
        })
        .catch(() => {
          /* unreadable now — the next event or refresh will say more */
        });
    })
      .then((off) => {
        if (alive) unlisten = off;
        else off();
      })
      .catch(() => {
        /* not running under Tauri (tests, web preview) — no watcher to join */
      });
    return () => {
      alive = false;
      if (unlisten) unlisten();
    };
  }, [absPath]);

  return { modified: loaded, dirty, saving, diskChanged, error, attach, save, reload };
}
