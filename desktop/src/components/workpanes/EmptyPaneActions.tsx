// What an empty pane shows: its starts, as a grid of outlined buttons — a new
// chat, a browser, a terminal on this computer — and "More…", which turns the
// pane into the launcher for everything else: every installed agent, the tabs
// and sessions running elsewhere, the starts that need a choice first.

import { useState, type ReactNode } from "react";
import { ChevronLeft, Ellipsis, Globe, Laptop, MessageSquarePlus, X } from "lucide-react";

import { useEditorStore, type WorkPaneRef } from "../../lib/editorStore";
import { Launcher } from "../launcher/Launcher";
import { Button } from "../ui/button";
import { startBrowser, startChat, startTerminal, type Place } from "./newTabStarts";
import "../ui/launcher.css";
import "../ui/new-tab.css";

/** Stable identity so the launcher's row list isn't rebuilt every render. */
const EMPTY: WorkPaneRef[] = [];

export function EmptyPaneActions({
  repoRoot,
  place,
  onClosePane,
  launcher = "panel",
}: {
  /** The workspace anything started here belongs to. */
  repoRoot: string;
  /** Puts what was started into this pane's slot. */
  place: Place;
  /** A split pane can be closed from here; the only pane of a surface can't. */
  onClosePane?: () => void;
  /** Which launcher "More…" opens: the landing surface's carries the switch
   *  to earlier sessions; a split pane's carries the starts that need a choice
   *  first. */
  launcher?: "panel" | "compact";
}) {
  const store = useEditorStore();
  const [more, setMore] = useState(false);

  const close = onClosePane && (
    <Button
      variant="ghost"
      size="iconXs"
      onClick={onClosePane}
      title="Close this pane"
      aria-label="Close this pane"
    >
      <X />
    </Button>
  );

  if (more) {
    return (
      <div
        className="ui-launcher-pane"
        onKeyDown={(e) => {
          if (e.key === "Escape") setMore(false);
        }}
      >
        <div className="ui-launcher-pane-head ui-empty-pane-head">
          <Button variant="ghost" size="xs" onClick={() => setMore(false)}>
            <ChevronLeft />
            Back
          </Button>
          {close}
        </div>
        <div className="ui-launcher-pane-body">
          <Launcher
            className="ui-launcher-in-pane"
            currentRepoRoot={repoRoot}
            variant={launcher}
            // An empty pane holds nothing, so nothing is filtered out —
            // including tabs open in other panes, which `place` moves here
            // rather than duplicating.
            present={EMPTY}
            place={place}
            autoFocus
          />
        </div>
      </div>
    );
  }

  return (
    <div className="ui-empty-pane">
      {close && <div className="ui-empty-pane-close">{close}</div>}
      <div className="ui-empty-pane-grid">
        <Action icon={<MessageSquarePlus />} label="New chat" onClick={() => void startChat(store, repoRoot, place)} />
        <Action icon={<Globe />} label="Browser" onClick={() => startBrowser(place)} />
        <Action icon={<Laptop />} label="Local terminal" onClick={() => startTerminal(store, repoRoot, place)} />
        <Action icon={<Ellipsis />} label="More…" onClick={() => setMore(true)} />
      </div>
    </div>
  );
}

function Action({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button variant="outline" className="ui-empty-pane-action" onClick={onClick}>
      {icon}
      {label}
    </Button>
  );
}
