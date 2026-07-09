// The terminal panel's top toolbar — mirrors VS Code's terminal toolbar:
//   [ zsh ⌄ ]  [ + ]  [ ⫼ split ]  [ 🗑 ]  [ … ]  [ ⛶ ]  [ ✕ ]
// The profile chip + the `+` and `...` buttons open the shared menus; the
// rest are direct actions on the active terminal / the panel itself.

import {
  Plus,
  ChevronDown,
  ChevronUp,
  Trash2,
  MoreHorizontal,
  SquareArrowOutUpRight,
  PanelRight,
  PanelRightClose,
  Search,
  X,
} from "lucide-react";
import type { TerminalProfile } from "../../lib/api";
import { SplitIcon } from "./icons";
import { TerminalNewMenu } from "./TerminalNewMenu";
import { TerminalOverflowMenu } from "./TerminalOverflowMenu";

type Props = {
  activeProfileName: string;
  profiles: TerminalProfile[];
  defaultProfileId: string | null;
  /** Whether the active terminal has a current text selection (gates Copy). */
  hasSelection: boolean;
  maximized: boolean;
  sideListOpen: boolean;
  hasActive: boolean;
  onNewTerminal: (profileId?: string) => void;
  onSplit: (profileId?: string) => void;
  onNewWindow?: () => void;
  onSelectDefaultProfile: (profileId: string) => void;
  onConfigureSettings: () => void;
  onKill: () => void;
  onClear: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onFind: () => void;
  onToggleMaximize: () => void;
  /** Move the active terminal into the center editor area as its own tab
   *  (VS Code's "Move Terminal into Editor Area"). */
  onOpenInEditor: () => void;
  onToggleSideList: () => void;
  onClosePanel: () => void;
};

const BTN =
  "h-6 w-6 grid place-items-center rounded text-text-4 hover:text-text-2 hover:bg-bg-hover disabled:opacity-40 disabled:hover:bg-transparent";

export function TerminalPanelToolbar({
  activeProfileName,
  profiles,
  defaultProfileId,
  hasSelection,
  maximized,
  sideListOpen,
  hasActive,
  onNewTerminal,
  onSplit,
  onNewWindow,
  onSelectDefaultProfile,
  onConfigureSettings,
  onKill,
  onClear,
  onCopy,
  onPaste,
  onSelectAll,
  onFind,
  onToggleMaximize,
  onOpenInEditor,
  onToggleSideList,
  onClosePanel,
}: Props) {
  return (
    <div className="h-8 px-2 flex items-center gap-1 border-b border-line-soft bg-bg-chrome flex-shrink-0">
      <span className="text-text-3 text-[11px] font-medium mr-1">Terminal</span>

      <TerminalNewMenu
        trigger={
          <button
            type="button"
            title="Launch profile"
            className="h-6 px-2 flex items-center gap-1 rounded text-text-3 text-[11px] hover:text-text-1 hover:bg-bg-hover"
          >
            <span className="font-mono text-text-4 text-[10px]">{">_"}</span>
            <span className="max-w-[120px] truncate">{activeProfileName}</span>
            <ChevronDown className="h-3 w-3 opacity-70" />
          </button>
        }
        profiles={profiles}
        defaultProfileId={defaultProfileId}
        onNewTerminal={onNewTerminal}
        onSplit={onSplit}
        onNewWindow={onNewWindow}
        onSelectDefaultProfile={onSelectDefaultProfile}
        onConfigureSettings={onConfigureSettings}
        align="start"
      />

      <div className="flex-1" />

      <button type="button" title="New Terminal" className={BTN} onClick={() => onNewTerminal()}>
        <Plus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title="Split Terminal"
        className={BTN}
        disabled={!hasActive}
        onClick={() => onSplit()}
      >
        <SplitIcon className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title="Find (⌘F)"
        className={BTN}
        disabled={!hasActive}
        onClick={onFind}
      >
        <Search className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title="Kill Terminal"
        className={BTN}
        disabled={!hasActive}
        onClick={onKill}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>

      <TerminalOverflowMenu
        trigger={
          <button type="button" title="More actions" className={BTN} disabled={!hasActive}>
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        }
        hasSelection={hasSelection}
        onClear={onClear}
        onCopy={onCopy}
        onPaste={onPaste}
        onSelectAll={onSelectAll}
        onKill={onKill}
      />

      <button
        type="button"
        title={sideListOpen ? "Hide terminal list" : "Show terminal list"}
        className={BTN}
        onClick={onToggleSideList}
      >
        {sideListOpen ? (
          <PanelRightClose className="h-3.5 w-3.5" />
        ) : (
          <PanelRight className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        type="button"
        title="Open terminal in editor"
        className={BTN}
        disabled={!hasActive}
        onClick={onOpenInEditor}
      >
        <SquareArrowOutUpRight className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title={maximized ? "Restore panel" : "Maximize panel"}
        className={BTN}
        onClick={onToggleMaximize}
      >
        {maximized ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
      </button>
      <button type="button" title="Close panel" className={BTN} onClick={onClosePanel}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
