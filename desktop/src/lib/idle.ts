// Best-effort idle scheduling with a macrotask fallback.
//
// `requestIdleCallback` runs low-priority work in the gaps between paints, so
// warming a cache or pre-fetching sibling data never competes with the
// launch-critical render. Current WebKit / WKWebView (what Tauri embeds on
// macOS) supports it; the `setTimeout(0)` fallback keeps older engines (and
// any non-DOM context) working. Returns a cancel function so an effect can
// tear the pending callback down on unmount.

export function onIdle(cb: () => void, timeout = 500): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(() => cb(), { timeout });
    return () => {
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(id);
    };
  }
  const id = window.setTimeout(cb, 0);
  return () => window.clearTimeout(id);
}
