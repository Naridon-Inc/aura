// Whether the machine has a network connection, as the webview reports it,
// re-rendering when it comes and goes.

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function online(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, online, () => true);
}
