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
import { ToastActionButton, ToastCard, ToastStack } from "./ui/toast";

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
    <ToastStack bottom={44} zIndex={9998}>
      <ToastCard
        key={notice.key}
        tone="success"
        title="Recording is on"
        message={
          <>
            Aura is now saving the story of every change in{" "}
            <span className="text-text-2">{notice.project}</span>, so you can always see what
            happened and undo anything. You can turn it off whenever you like.
          </>
        }
        onDismiss={() => setNotice(null)}
        actions={
          <ToastActionButton variant="primary" onClick={manage}>
            Recording settings
          </ToastActionButton>
        }
      />
    </ToastStack>
  );
}
