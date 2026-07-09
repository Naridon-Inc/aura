// Renders plugin-emitted toasts (`ui.toast` host method). Mounts once
// next to CrashRecoveryToast; listens for the `aura:plugin-toast`
// CustomEvent the plugin runtime dispatches after the bridge has
// capability-checked the call.
//
// Deliberately small: stacked fixed bottom-right cards, newest on top,
// auto-dismiss after 5s (errors stick until clicked). Every card names
// the plugin that produced it — plugins never get anonymous UI.

import { useEffect, useState } from "react";
import type { PluginToast } from "../lib/pluginRuntime";

type ActiveToast = PluginToast & { key: number };

const AUTO_DISMISS_MS = 5000;
const MAX_VISIBLE = 4;

let nextKey = 1;

function kindColor(kind: PluginToast["kind"]): string {
  switch (kind) {
    case "error":
      return "var(--color-danger, #ef4444)";
    case "warn":
      return "var(--color-warning, #d97706)";
    default:
      return "var(--color-accent, #5aa9e6)";
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
    <div
      style={{
        position: "fixed",
        bottom: 44,
        right: 16,
        zIndex: 9998,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 380,
      }}
    >
      {toasts.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() =>
            setToasts((prev) => prev.filter((x) => x.key !== t.key))
          }
          style={{
            textAlign: "left",
            cursor: "pointer",
            background: "var(--color-bg-elevated, #1a1a1a)",
            border: "1px solid var(--color-border, #2a2a2a)",
            borderLeft: `3px solid ${kindColor(t.kind)}`,
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            color: "var(--color-text, #e5e7eb)",
            padding: "10px 12px",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          <div
            style={{
              color: "var(--color-text-dim, #9ca3af)",
              fontSize: 10,
              marginBottom: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {t.pluginId}
          </div>
          <div style={{ wordBreak: "break-word" }}>{t.message}</div>
        </button>
      ))}
    </div>
  );
}
