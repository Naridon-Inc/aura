// Coming back to the window is the moment a reader expects to see what
// happened while they were away, so a story re-reads itself then, at most
// once per gap.

import { useEffect, useRef } from "react";

const MIN_GAP_MS = 20_000;

export function useRefreshOnReturn(load: () => unknown) {
  const askedAt = useRef(Date.now());
  useEffect(() => {
    function refreshOnReturn() {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - askedAt.current < MIN_GAP_MS) return;
      askedAt.current = Date.now();
      void load();
    }
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [load]);
}
