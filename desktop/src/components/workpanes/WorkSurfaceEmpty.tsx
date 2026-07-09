// WorkSurface empty state — the calm landing surface shown when no editor
// tab is open (and the default when a workspace first opens). Modeled on the
// reference editors' empty pane: a single muted code-bracket glyph centered
// over a short vertical list of "open something" actions, each with its real
// keyboard hint. Rendered entirely on Aura's design tokens — no hardcoded
// colours. Coding agents launch from the preset bar above; this surface
// covers the everyday "open a terminal / team chat / search" reaches.

import type { ReactNode } from "react";

type Props = {
  repoRoot: string;
  projectName: string;
  onOpenTerminal: () => void;
  onOpenChat: () => void;
  onSearch: () => void;
};

type EmptyAction = {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** Real Aura keybinding, shown as kbd chips. Omitted when the action has
   *  no global shortcut — we never show a hint that doesn't fire. */
  keys?: string[];
};

export function WorkSurfaceEmpty({
  projectName,
  onOpenTerminal,
  onOpenChat,
  onSearch,
}: Props) {
  const actions: EmptyAction[] = [
    {
      key: "terminal",
      label: "Open Terminal",
      icon: <TerminalIcon />,
      onClick: onOpenTerminal,
    },
    {
      key: "chat",
      label: "Open Team Chat",
      icon: <ChatIcon />,
      onClick: onOpenChat,
    },
    {
      key: "search",
      label: "Search Files",
      icon: <SearchIcon />,
      onClick: onSearch,
      keys: ["⌘", "⇧", "F"],
    },
  ];

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-bg-content px-8">
      <BracketGlyph />
      <div className="mt-10 w-full max-w-[360px] flex flex-col">
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={a.onClick}
            className="group flex items-center gap-3 h-10 px-3 rounded-md text-text-3 hover:text-text-1 hover:bg-bg-2 transition-colors"
          >
            <span className="text-text-4 group-hover:text-text-2 transition-colors">
              {a.icon}
            </span>
            <span className="flex-1 text-left text-[13px]">{a.label}</span>
            {a.keys && (
              <span className="flex items-center gap-1">
                {a.keys.map((k, i) => (
                  <kbd
                    key={i}
                    className="min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded border border-line-soft bg-bg-1 text-[10.5px] text-text-4 font-sans"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="mt-8 text-[11.5px] text-text-5">
        Pick a coding agent from the bar above to start in{" "}
        <span className="text-text-4">{projectName}</span>.
      </div>
    </div>
  );
}

// Muted code-bracket mark — the single piece of identity on the surface.
// Two facing brackets framing a dot, drawn from the line tokens so it sits
// quietly behind the actions rather than competing with them.
function BracketGlyph() {
  return (
    <svg
      width="72"
      height="48"
      viewBox="0 0 72 48"
      fill="none"
      aria-hidden
      className="text-text-5"
    >
      <path
        d="M26 8 L14 8 Q9 8 9 13 L9 20 Q9 24 5 24 Q9 24 9 28 L9 35 Q9 40 14 40 L26 40"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M46 8 L58 8 Q63 8 63 13 L63 20 Q63 24 67 24 Q63 24 63 28 L63 35 Q63 40 58 40 L46 40"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="36" cy="24" r="2.4" fill="currentColor" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 6l2.2 2L4 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 10.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
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
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
