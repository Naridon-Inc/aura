// Reads document.visibilityState reactively. Used to gate background
// polls — when the window is hidden (Cmd-Tab away, dock minimize), there
// is no reason to keep hammering the disk for status chips. The browser
// pauses requestAnimationFrame, but our timers/intervals keep firing
// regardless, so we have to opt in to pausing them ourselves.

import { useEffect, useState } from "react";

/** Returns true when the document is currently visible to the user. */
export function useDocumentVisibility(): boolean {
  const [visible, setVisible] = useState<boolean>(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  useEffect(() => {
    function onChange() {
      setVisible(document.visibilityState === "visible");
    }
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
