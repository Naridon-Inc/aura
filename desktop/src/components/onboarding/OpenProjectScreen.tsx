// Screen 3 — Open Project. The drop-zone the reference editor opens on:
// drag a folder onto the window or click to browse. Recently-opened repos
// sit below for one-click reopen, and "New Project" routes to the create
// screen. Opening a project dispatches the same `aura:open-repo-picker-path`
// event App.tsx already listens for, then ends onboarding.

import { useCallback, useEffect, useState } from "react";
import { OnboardingCenter } from "./OnboardingShell";
import { FolderIcon, PlusIcon } from "./icons";
import { Button } from "../ui/button";

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem("aura.recents");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

export function OpenProjectScreen({
  onOpened,
  onNewProject,
}: {
  /** Called with the chosen project root once a project is opening. */
  onOpened: (root: string) => void;
  onNewProject: () => void;
}) {
  const [recents, setRecents] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setRecents(readRecents());
  }, []);

  const open = useCallback(
    (root: string) => {
      window.dispatchEvent(
        new CustomEvent("aura:open-repo-picker-path", { detail: { path: root } }),
      );
      onOpened(root);
    },
    [onOpened],
  );

  const browse = useCallback(() => {
    import("../../lib/nativeDialog")
      .then(async ({ pickPath }) => {
        const picked = await pickPath({ directory: true, multiple: false });
        if (typeof picked === "string" && picked) open(picked);
      })
      .catch(() => {});
  }, [open]);

  // Native folder drop onto the window (Tauri drag-drop, same API the chat
  // uploader uses). Only the first dropped path is taken.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const off = await getCurrentWebview().onDragDropEvent((evt) => {
          if (cancelled) return;
          const payload = evt.payload as unknown as {
            type?: string;
            paths?: string[];
          };
          if (payload?.type === "over") setDragging(true);
          else if (payload?.type === "leave" || payload?.type === "cancel")
            setDragging(false);
          else if (payload?.type === "drop") {
            setDragging(false);
            const first = payload.paths?.find(Boolean);
            if (first) open(first);
          }
        });
        unlisten = off;
      } catch {
        /* not in a webview — drop unavailable, browse still works */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open]);

  return (
    <OnboardingCenter width={460}>
      <button
        type="button"
        onClick={browse}
        className={[
          "w-full rounded-lg border border-dashed transition-colors",
          "flex flex-col items-center justify-center text-center px-6 py-12",
          dragging
            ? "border-accent bg-accent-soft"
            : "border-line-soft bg-bg-2/40 hover:bg-state-hover hover:border-line-strong",
        ].join(" ")}
      >
        <span className="inline-flex items-center gap-2.5 text-text-1">
          <span className="text-text-3">
            <FolderIcon />
          </span>
          <span className="text-md font-medium">Open Project</span>
        </span>
        <span className="mt-2 text-sm text-text-4">
          Drag a folder with .git or click to browse
        </span>
      </button>

      {recents.length > 0 ? (
        <div className="mt-5 w-full">
          <div className="section-label px-1 mb-1.5">
            Recent
          </div>
          <div className="flex flex-col">
            {recents.slice(0, 5).map((root) => {
              const name = root.split("/").filter(Boolean).pop() ?? root;
              return (
                <button
                  key={root}
                  type="button"
                  onClick={() => open(root)}
                  className="group flex items-center gap-2.5 h-9 px-2 rounded-md hover:bg-state-hover transition-colors text-left"
                >
                  <span className="text-text-5 group-hover:text-text-3 transition-colors">
                    <FolderIcon size={15} />
                  </span>
                  <span className="text-base text-text-2 group-hover:text-text-1 transition-colors shrink-0">
                    {name}
                  </span>
                  <span className="text-xs text-text-5 truncate">{root}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-6 flex items-center gap-2 text-sm text-text-4">
        <span>Or start a new project</span>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          onClick={onNewProject}
        >
          <PlusIcon /> New Project
        </Button>
      </div>
    </OnboardingCenter>
  );
}
