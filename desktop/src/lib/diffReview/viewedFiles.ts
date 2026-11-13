// "Viewed" marks on changed files, kept on this device.
//
// Marking a file viewed records what its change looked like at that moment.
// It stays viewed while the change is the same; once the file changes again
// the mark no longer holds and the diff offers to show the newer changes.
// The diff pane and the changed-files list both decide by one key, a hash of
// the file's patch, so they never disagree about a file. Marks older than
// thirty days are dropped on the next write.

export type ViewedMark = {
  at: number;
  /** Hash of the patch that was on screen when the file was marked. */
  sig: string;
};

type Book = Record<string, Record<string, ViewedMark>>;

export const VIEWED_KEY = "aura.diffReview.viewed.v1";
export const VIEWED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const listeners = new Set<() => void>();
let cache: Book | null = null;
let version = 0;

function read(): Book {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(VIEWED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Book) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function prune(book: Book, now: number): Book {
  const out: Book = {};
  for (const [ws, files] of Object.entries(book)) {
    const kept: Record<string, ViewedMark> = {};
    for (const [path, mark] of Object.entries(files ?? {})) {
      if (mark && typeof mark.at === "number" && now - mark.at < VIEWED_TTL_MS) kept[path] = mark;
    }
    if (Object.keys(kept).length > 0) out[ws] = kept;
  }
  return out;
}

function write(next: Book) {
  cache = next;
  version++;
  try {
    localStorage.setItem(VIEWED_KEY, JSON.stringify(next));
  } catch {
    /* storage full or disabled — the marks still hold for this session */
  }
  for (const fn of listeners) fn();
}

export function subscribeViewed(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Bumps on every change, for `useSyncExternalStore` snapshots. */
export function viewedVersion(): number {
  return version;
}

/** Tests only. */
export function resetViewedCache(): void {
  cache = null;
}

/** A short stable hash of a patch (FNV-1a, 32 bit). */
export function patchSig(patch: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < patch.length; i++) {
    h ^= patch.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function getViewed(workspace: string, path: string): ViewedMark | undefined {
  return read()[workspace]?.[path];
}

export function markViewed(workspace: string, path: string, patch: string, now = Date.now()): void {
  const book = prune(read(), now);
  const files = { ...(book[workspace] ?? {}) };
  files[path] = { at: now, sig: patchSig(patch) };
  write({ ...book, [workspace]: files });
}

export function unmarkViewed(workspace: string, path: string): void {
  const book = read();
  if (!book[workspace]?.[path]) return;
  const files = { ...book[workspace] };
  delete files[path];
  const next = { ...book };
  if (Object.keys(files).length > 0) next[workspace] = files;
  else delete next[workspace];
  write(next);
}

export type ViewedState = "unviewed" | "viewed" | "changed";

/** Against the hash of the file's patch now: viewed, never viewed, or viewed
 *  and then changed since. Both the pane and the list come through here. */
export function viewedStateBySig(workspace: string, path: string, sig: string | undefined): ViewedState {
  const mark = getViewed(workspace, path);
  if (!mark) return "unviewed";
  return sig !== undefined && mark.sig === sig ? "viewed" : "changed";
}

/** Against the patch now on screen. */
export function viewedState(workspace: string, path: string, patch: string): ViewedState {
  return viewedStateBySig(workspace, path, patchSig(patch));
}
