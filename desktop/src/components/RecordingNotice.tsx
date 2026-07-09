// The heads-up shown the first time Aura turns recording on for a project.
//
// Auto-enabling capture (see lib/autoCapture.ts) without telling anyone would
// be a surprise — these are non-engineers who fear AI silently changing their
// files. So we say it plainly, once, in their words: Aura is now saving the
// story of every change so they can see what happened and undo anything, and
// they can switch it off whenever they like. No git/AST/hook jargon.
//
// Listens for the `aura:recording-on` CustomEvent the auto-enable path fires.
// Auto-dismisses after a beat; "Manage" deep-links to Settings → Capture.

import { useEffect, useState } from "react";

const AUTO_DISMISS_MS = 11000;

type Notice = { project: string; key: number };

let nextKey = 1;

export function RecordingNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onOn = (e: Event) => {
      const detail = (e as CustomEvent<{ project?: string }>).detail;
      const project = (detail?.project ?? "").trim() || "this project";
      setNotice({ project, key: nextKey++ });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setNotice(null), AUTO_DISMISS_MS);
    };
    window.addEventListener("aura:recording-on", onOn);
    return () => {
      window.removeEventListener("aura:recording-on", onOn);
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!notice) return null;

  const manage = () => {
    setNotice(null);
    window.dispatchEvent(
      new CustomEvent("aura:open-settings", { detail: { pane: "capture" } }),
    );
  };

  return (
    <div
      key={notice.key}
      style={{
        position: "fixed",
        bottom: 44,
        right: 16,
        zIndex: 9998,
        maxWidth: 360,
        background: "var(--color-bg-elevated, #1a1a1a)",
        border: "1px solid var(--color-border, #2a2a2a)",
        borderLeft: "3px solid var(--color-accent, #5aa9e6)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        color: "var(--color-text, #e5e7eb)",
        padding: "12px 14px",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          fontWeight: 600,
          marginBottom: 4,
          color: "var(--color-text, #e5e7eb)",
        }}
      >
        Recording is on
      </div>
      <div style={{ color: "var(--color-text-dim, #9ca3af)" }}>
        Aura is now saving the story of every change in{" "}
        <span style={{ color: "var(--color-text, #e5e7eb)" }}>
          {notice.project}
        </span>
        , so you can always see what happened and undo anything. You can turn it
        off whenever you like.
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 10,
          justifyContent: "flex-end",
        }}
      >
        <button
          type="button"
          onClick={() => setNotice(null)}
          style={{
            cursor: "pointer",
            background: "transparent",
            border: "none",
            color: "var(--color-text-dim, #9ca3af)",
            fontSize: 12,
            padding: "4px 8px",
          }}
        >
          Got it
        </button>
        <button
          type="button"
          onClick={manage}
          style={{
            cursor: "pointer",
            background: "transparent",
            border: "1px solid var(--color-border, #2a2a2a)",
            borderRadius: 6,
            color: "var(--color-accent, #5aa9e6)",
            fontSize: 12,
            padding: "4px 10px",
          }}
        >
          Manage
        </button>
      </div>
    </div>
  );
}
