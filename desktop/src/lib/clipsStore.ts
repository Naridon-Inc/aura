// Clipboard tray store. Mirrors `~/.aura/clips/` — pasted screenshots
// and dragged-in files saved with absolute paths agents can read. Items
// are listed newest-first; the backend caps the directory at 50 so we
// don't grow unbounded.

import { useEffect, useSyncExternalStore } from "react";
import { api, type ClipEntry } from "./api";

type State = {
  entries: ClipEntry[];
  loaded: boolean;
};

let state: State = { entries: [], loaded: false };
const subs = new Set<() => void>();

function emit() {
  subs.forEach((s) => s());
}
function set(next: Partial<State>) {
  state = { ...state, ...next };
  emit();
}

let inflight: Promise<void> | null = null;
async function reload() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const entries = await api.clipsList();
      set({ entries, loaded: true });
    } catch (err) {
      console.warn("clips: list failed", err);
      set({ loaded: true });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useClips(): { entries: ClipEntry[]; loaded: boolean } {
  const snap = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (!snap.loaded) reload();
  }, [snap.loaded]);
  return snap;
}

export async function refreshClips() {
  await reload();
}

/** Save a pasted image (raw PNG bytes wrapped in a Blob/File). The
 *  backend returns the persisted entry which we splice to the head of
 *  the list immediately for snappy feedback. */
export async function saveImageBlob(name: string, blob: Blob): Promise<ClipEntry | null> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  // btoa requires a binary string; chunk so we don't blow the stack
  // on large screenshots (call-arg limit ~64k chars).
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    );
  }
  const b64 = btoa(binary);
  try {
    const entry = await api.clipsSaveImage(name, b64);
    set({ entries: [entry, ...state.entries.filter((e) => e.id !== entry.id)] });
    return entry;
  } catch (err) {
    console.warn("clips: save image failed", err);
    return null;
  }
}

export async function saveFilePath(origPath: string): Promise<ClipEntry | null> {
  try {
    const entry = await api.clipsSaveFile(origPath);
    set({ entries: [entry, ...state.entries.filter((e) => e.id !== entry.id)] });
    return entry;
  } catch (err) {
    console.warn("clips: save file failed", err);
    return null;
  }
}

export async function removeClip(id: string) {
  try {
    await api.clipsRemove(id);
    set({ entries: state.entries.filter((e) => e.id !== id) });
  } catch (err) {
    console.warn("clips: remove failed", err);
  }
}

export async function clearClips() {
  try {
    await api.clipsClear();
    set({ entries: [] });
  } catch (err) {
    console.warn("clips: clear failed", err);
  }
}

// Subscribe to backend-driven inserts (the screenshot watcher in
// `clips_watch.rs` emits `clips:added` whenever a system screenshot
// lands in ~/Desktop or the user's configured screencapture dir). We
// just refresh the list — the new entry is newest-first by mtime.
let listenerAttached = false;
async function attachAddedListener() {
  if (listenerAttached) return;
  listenerAttached = true;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("clips:added", () => {
      reload();
    });
  } catch (err) {
    console.warn("clips: cannot attach added-listener", err);
    listenerAttached = false;
  }
}
attachAddedListener();
