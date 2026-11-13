// The heads-up shown the first time Aura turns recording on for a project.
//
// Auto-enabling capture (see lib/autoCapture.ts) without telling anyone would
// be a surprise — these are non-engineers who fear AI silently changing their
// files. So we say it plainly, once, in their words: Aura is now saving the
// story of every change so they can see what happened and undo anything, and
// they can switch it off whenever they like. No git/AST/hook jargon.
//
// Listens for the `aura:recording-on` CustomEvent the auto-enable path fires
// and raises one toast in the shared stack; "Recording settings" deep-links to
// Settings → Capture. Renders nothing itself.

import { useEffect } from "react";
import { toast } from "../lib/toast";

/** Long enough to read the two sentences. */
const AUTO_DISMISS_MS = 11000;
const TOAST_ID = "recording-on";

export function RecordingNotice() {
  useEffect(() => {
    const onOn = (e: Event) => {
      const detail = (e as CustomEvent<{ project?: string }>).detail;
      const project = (detail?.project ?? "").trim() || "this repository";
      toast.success(
        "Recording is on",
        <>
          Aura is now saving the story of every change in{" "}
          <span className="text-[var(--aura-toast-text)]">{project}</span>, so you can always
          see what happened and undo anything. You can turn it off whenever you like.
        </>,
        {
          id: TOAST_ID,
          durationMs: AUTO_DISMISS_MS,
          actions: [
            {
              label: "Recording settings",
              variant: "primary",
              onClick: () => {
                window.dispatchEvent(
                  new CustomEvent("aura:open-settings", { detail: { pane: "capture" } }),
                );
              },
            },
          ],
        },
      );
    };
    window.addEventListener("aura:recording-on", onOn);
    return () => window.removeEventListener("aura:recording-on", onOn);
  }, []);

  return null;
}
