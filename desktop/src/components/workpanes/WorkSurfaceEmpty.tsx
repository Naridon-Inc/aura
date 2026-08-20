// WorkSurface empty state — the surface you land on when a workspace opens
// and nothing is in it yet.
//
// It used to offer three things: a terminal, the Team place, and file search.
// Not a coding agent, not a chat, not anything you had already been running —
// and its closing line read "Pick a coding agent from the bar above", pointing
// at a row that deliberately draws no launcher, because (its own comment says)
// "the surface underneath it IS the launcher". It wasn't.
//
// It hosts the real launcher now — the same body the "+" and an empty split
// pane use — in its `compact` variant: the list and its search, without the
// three "needs a choice first" menus. Someone who has just opened a workspace
// came to start a Claude, not to choose an inference endpoint.
//
// One card, one mark, one line of links. The identity is the product's own
// logo rather than a glyph invented for this screen, and this is the one
// place it gets to play the brand kit's build-in — everywhere else the mark
// is furniture in a 13px slot, where motion would only be noise.

import type { ReactNode } from "react";

import { useEditorStore, type WorkPaneRef } from "../../lib/editorStore";
import { AuraMark } from "../AuraMark";
import { Launcher } from "../launcher/Launcher";
import { Kbd } from "../ui/kbd";

type Props = {
  repoRoot: string;
  projectName: string;
  onOpenChat: () => void;
  onSearch: () => void;
};

/** Stable identity so the launcher's row list isn't rebuilt every render. */
const EMPTY: WorkPaneRef[] = [];

export function WorkSurfaceEmpty({
  repoRoot,
  projectName,
  onOpenChat,
  onSearch,
}: Props) {
  const store = useEditorStore();

  return (
    <div className="h-full w-full min-h-0 flex flex-col items-center justify-center bg-bg-content px-6 py-6">
      <div className="w-full max-w-[440px] min-h-0 flex flex-col">
        <div className="flex-shrink-0 flex justify-center mb-4 text-accent">
          <AuraMark size={64} animated />
        </div>

        {/* The launcher inside a real container. Loose in the middle of the
            surface its own header and footer hairlines read as two stray
            lines floating on nothing — a card is what makes them edges. */}
        <div className="min-h-0 flex flex-col rounded-lg border border-line-soft bg-bg-2 overflow-hidden max-h-[46vh]">
          <Launcher
            className="w-full min-h-0"
            currentRepoRoot={repoRoot}
            variant="compact"
            // The surface holds nothing, so nothing is filtered out — including
            // tabs and live agents living elsewhere, which a pick moves here.
            present={EMPTY}
            // Whatever is started has already put itself in the layout; this
            // drops it into the slot the reader is looking at rather than
            // leaving them on an empty surface with the work in another pane.
            place={(ref: WorkPaneRef) => store.replaceSplitPaneAt(0, ref)}
          />
        </div>

        {/* No "Earlier sessions" here any more: the launcher's own switch is
            that, one click nearer and with the sessions themselves under it
            rather than a page you leave for. What stays are the two things
            this surface can't start — a conversation with people, and a search
            across the files. */}
        <div className="mt-3 flex items-center justify-center gap-0.5 flex-wrap text-xs text-text-5">
          <FooterLink icon={<ChatIcon />} label="Team chat" onClick={onOpenChat} />
          <FooterLink
            icon={<SearchIcon />}
            label="Search files"
            onClick={onSearch}
            keys={["⌘", "⇧", "F"]}
          />
        </div>

        <div className="mt-1.5 text-center text-xs text-text-5">
          Starting in <span className="text-text-4">{projectName}</span>
        </div>
      </div>
    </div>
  );
}

function FooterLink({
  icon,
  label,
  onClick,
  keys,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  /** Real Aura keybinding. Omitted when the action has no global shortcut —
   *  we never print a hint that doesn't fire. */
  keys?: string[];
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-1.5 h-6 px-2 rounded text-text-4 hover:text-text-1 hover:bg-state-hover transition-colors"
    >
      <span className="text-text-5 group-hover:text-text-3 transition-colors">
        {icon}
      </span>
      <span>{label}</span>
      {keys && (
        <span className="flex items-center gap-0.5">
          {keys.map((k, i) => (
            <Kbd key={i}>{k}</Kbd>
          ))}
        </span>
      )}
    </button>
  );
}

function ChatIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 3v-3H3a1 1 0 0 1-1-1V4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
