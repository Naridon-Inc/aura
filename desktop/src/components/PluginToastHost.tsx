// Renders plugin-emitted toasts (`ui.toast` host method). Mounts once
// next to CrashRecoveryToast; listens for the `aura:plugin-toast`
// CustomEvent the plugin runtime dispatches after the bridge has
// capability-checked the call.
//
// Deliberately small: stacked fixed bottom-right cards, newest on top,
// auto-dismiss after 5s (errors stick until clicked). Every card names
// the plugin that produced it — plugins never get anonymous UI.
//
// Wears the shared `ui/toast` card so a plugin toast is indistinguishable
// in shape from an app toast; only the tone stripe differs.

import { useEffect, useState } from "react";
import type { PluginToast } from "../lib/pluginRuntime";
import { ToastCard, ToastStack, type ToastTone } from "./ui/toast";

type ActiveToast = PluginToast & { key: number };

const AUTO_DISMISS_MS = 5000;
const MAX_VISIBLE = 4;

let nextKey = 1;

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
  const [toasts, setToasts] = useState<ActiveToast[]>([]);

  useEffect(() => {
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<PluginToast>).detail;
      if (!detail || typeof detail.message !== "string") return;
      const t: ActiveToast = { ...detail, key: nextKey++ };
      setToasts((prev) => [t, ...prev].slice(0, MAX_VISIBLE));
      if (t.kind !== "error") {
        timers.set(
          t.key,
          setTimeout(() => {
            timers.delete(t.key);
            setToasts((prev) => prev.filter((x) => x.key !== t.key));
          }, AUTO_DISMISS_MS),
        );
      }
    };
    window.addEventListener("aura:plugin-toast", onToast);
    return () => {
      window.removeEventListener("aura:plugin-toast", onToast);
      for (const h of timers.values()) clearTimeout(h);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <ToastStack bottom={44} zIndex={9998}>
      {toasts.map((t) => (
        <ToastCard
          key={t.key}
          tone={kindTone(t.kind)}
          role={t.kind === "error" ? "alert" : "status"}
          title={t.pluginId}
          message={<span className="break-words text-text-2">{t.message}</span>}
          onDismiss={() => setToasts((prev) => prev.filter((x) => x.key !== t.key))}
        />
      ))}
    </ToastStack>
  );
}
