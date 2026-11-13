// Renders plugin-emitted toasts (`ui.toast` host method). Mounts once at the
// app root; listens for the `aura:plugin-toast` CustomEvent the plugin runtime
// dispatches after the bridge has capability-checked the call.
//
// Each one goes into the shared stack, so a plugin toast is indistinguishable
// in shape from an app toast. It closes after five seconds (errors stay until
// closed), and is titled with the plugin that produced it — plugins never get
// anonymous UI. Renders nothing itself.

import { useEffect } from "react";
import type { PluginToast } from "../lib/pluginRuntime";
import { toast, type ToastTone } from "../lib/toast";

function kindTone(kind: PluginToast["kind"]): ToastTone {
  switch (kind) {
    case "error":
      return "danger";
    case "warn":
      return "warning";
    default:
      return "info";
  }
}

export function PluginToastHost() {
  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<PluginToast>).detail;
      if (!detail || typeof detail.message !== "string") return;
      toast.show({
        tone: kindTone(detail.kind),
        title: detail.pluginId,
        message: detail.message,
        durationMs: detail.kind === "error" ? null : undefined,
      });
    };
    window.addEventListener("aura:plugin-toast", onToast);
    return () => window.removeEventListener("aura:plugin-toast", onToast);
  }, []);

  return null;
}
