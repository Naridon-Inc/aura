// Shared thumbnail cache for clipboard-tray images.
//
// The backend's `clipsReadDataUrl` returns the FULL resolution data
// URL — a 4K screenshot can be 10 MB of base64. The tray renders the
// same image at ~36–96 px in multiple places (collapsed tile, hover
// fan, panel row), so without a downsample step every visible thumb
// parks 10 MB in React state and the browser keeps the decoded bitmap
// alive too. With 30+ clips the heap balloons.
//
// This module owns a single in-process cache. Callers ask for a
// thumbnail by clip id; we fetch the source data URL once, downsample
// to MAX_DIM × MAX_DIM via canvas, and hand back a small data URL.
// Subsequent callers for the same clip get the cached result without
// re-fetching or re-decoding.
//
// LRU bound on the cache — clips churn, so we cap the resident
// thumbnail count and evict the least-recently-used when we'd exceed
// the cap. Each thumbnail is ~5–15 KB so the cap × per-thumb is in
// the low MB range, not GB.

const MAX_DIM = 96;
const CACHE_CAP = 120;
const TARGET_MIME = "image/webp"; // Compact, supported in every WebKit/Chromium.

const cache = new Map<string, string>(); // id → thumbnail data URL
const inFlight = new Map<string, Promise<string | null>>();
const listeners = new Map<string, Set<() => void>>();

function notify(id: string) {
  const set = listeners.get(id);
  if (set) for (const fn of set) fn();
}

function touch(id: string, value: string) {
  // LRU touch: deleting + re-adding puts the key at the tail (most-
  // recently inserted in iteration order).
  cache.delete(id);
  cache.set(id, value);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function getCachedThumbnail(id: string): string | null {
  const hit = cache.get(id);
  if (hit) {
    // Touch on read so frequently-rendered thumbs don't get evicted.
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  return null;
}

export function subscribeThumbnail(id: string, fn: () => void): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(fn);
  return () => {
    const s = listeners.get(id);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listeners.delete(id);
  };
}

/** Resolve a thumbnail for the given clip id. Calls `loadFullDataUrl`
 *  once to fetch the raw image, downsamples via canvas, caches the
 *  result, and notifies subscribers. Concurrent calls for the same id
 *  share a single in-flight promise. */
export async function loadThumbnail(
  id: string,
  loadFullDataUrl: (id: string) => Promise<string>,
): Promise<string | null> {
  const hit = getCachedThumbnail(id);
  if (hit) return hit;
  const pending = inFlight.get(id);
  if (pending) return pending;
  const p = (async () => {
    try {
      const url = await loadFullDataUrl(id);
      const thumb = await downsample(url, MAX_DIM, TARGET_MIME);
      if (!thumb) return null;
      touch(id, thumb);
      notify(id);
      return thumb;
    } catch {
      return null;
    } finally {
      inFlight.delete(id);
    }
  })();
  inFlight.set(id, p);
  return p;
}

function downsample(
  sourceUrl: string,
  maxDim: number,
  mime: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w === 0 || h === 0) {
        resolve(null);
        return;
      }
      const ratio = w / h;
      const targetW = ratio >= 1 ? Math.min(maxDim, w) : Math.round(maxDim * ratio);
      const targetH = ratio >= 1 ? Math.round(maxDim / ratio) : Math.min(maxDim, h);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, targetW);
      canvas.height = Math.max(1, targetH);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        // Quality 0.75 → small file, still readable as a thumb.
        const out = canvas.toDataURL(mime, 0.75);
        resolve(out || null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = sourceUrl;
  });
}

export function clearThumbnailCache(): void {
  cache.clear();
  inFlight.clear();
}
