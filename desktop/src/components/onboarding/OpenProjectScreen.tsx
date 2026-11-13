// First run, step three: open a project. Drag a folder onto the window or
// choose one; recently opened repositories sit below for one click, and
// "New project" goes to the create page. Opening dispatches the same
// `aura:open-repo-picker-path` event App.tsx already listens for, then ends
// first run.

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Folder, FolderOpen, Plus } from "lucide-react";
import { Button } from "../ui/button";
import "../ui/cloud-onboarding.css";
import "../ui/cloud-patterns.css";
import "../ui/onboarding.css";

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem("aura.recents");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
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

  // Native folder drop onto the window (Tauri drag-drop, the same API the
  // chat uploader uses). Only the first dropped path is taken.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const off = await getCurrentWebview().onDragDropEvent((evt) => {
          if (cancelled) return;
          const payload = evt.payload as unknown as { type?: string; paths?: string[] };
          if (payload?.type === "over") setDragging(true);
          else if (payload?.type === "leave" || payload?.type === "cancel") setDragging(false);
          else if (payload?.type === "drop") {
            setDragging(false);
            const first = payload.paths?.find(Boolean);
            if (first) open(first);
          }
        });
        unlisten = off;
      } catch {
        /* not in a webview — drop unavailable, choosing still works */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open]);

  return (
    <>
      <header>
        <h1>Open a repository</h1>
        <p>
          {dragging
            ? "Let go to open it."
            : "Drag a folder with a .git inside onto this window, or choose one."}
        </p>
      </header>

      <Button type="button" variant="outline" className="ui-cloud-repo-select" onClick={browse}>
        Choose a folder
        <FolderOpen />
      </Button>

      {recents.length > 0 ? (
        <section className="ui-onboarding-section" aria-label="Recent repositories">
          <small>Recent</small>
          <div className="ui-cloud-agent-connections ui-onboarding-rows">
            {recents.slice(0, 5).map((root) => {
              const name = root.split("/").filter(Boolean).pop() ?? root;
              return (
                <button key={root} type="button" onClick={() => open(root)} title={root}>
                  <Folder size={16} aria-hidden />
                  <span>{name}</span>
                  <small className="ui-onboarding-path">{root}</small>
                  <ArrowRight size={14} aria-hidden />
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <div className="ui-cloud-inline">
        <small>Or start a new repository</small>
        <Button type="button" variant="secondary" size="sm" onClick={onNewProject}>
          <Plus />
          New repository
        </Button>
      </div>
    </>
  );
}
