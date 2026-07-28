// The floating mobile-style control bar that docks below the page (the
// reference's result-screen bottom controls). Primary row: a card-stack tab
// switcher (left), a big "+" new-tab pill (centre), and an expand chevron
// (right) that reveals the secondary nav row (back / forward / reload / browse
// -for-me). A small engine-toggle pill (Aura ⇄ Google) floats above the bar.
//
// It can't truly float OVER the page — the native webview paints above the
// React DOM — so it's docked: the bar is a flex sibling below the webview hole,
// and expanding it shrinks the hole above (reconcile repositions the webview).

import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronUp,
  MessageSquarePlus,
  MousePointerClick,
  Plus,
  RotateCw,
  Sparkles,
  SquareStack,
} from "lucide-react";

export function BrowserBottomBar({
  tabCount,
  engine,
  loading,
  canBack,
  canForward,
  canReload,
  onToggleTabs,
  onNewTab,
  onSetEngine,
  onBack,
  onForward,
  onReload,
  onBrowseForMe,
  annotating,
  annotationCount,
  canAnnotate,
  onToggleAnnotate,
  onAttachAnnotations,
}: {
  tabCount: number;
  engine: "aura" | "google";
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  canReload: boolean;
  onToggleTabs: () => void;
  onNewTab: () => void;
  onSetEngine: (engine: "aura" | "google") => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onBrowseForMe: () => void;
  /** Agentation: whether click-to-annotate mode is on, how many pins have been
   *  dropped, and the toggle / attach-to-chat actions. */
  annotating: boolean;
  annotationCount: number;
  canAnnotate: boolean;
  onToggleAnnotate: () => void;
  onAttachAnnotations: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="relative flex-shrink-0 bg-bg-1">
      {/* Engine toggle — floats above the bar, right-aligned. */}
      <div className="absolute right-3 -top-11 z-10 flex items-center gap-0.5 h-8 px-1 rounded-full bg-bg-2/95 border border-line-soft shadow-md backdrop-blur">
        <EngineSlot kind="aura" active={engine === "aura"} onClick={() => onSetEngine("aura")} />
        <EngineSlot
          kind="google"
          active={engine === "google"}
          onClick={() => onSetEngine("google")}
        />
      </div>

      {/* Secondary nav row (revealed by the chevron). */}
      {expanded && (
        <div className="flex items-center justify-center gap-3 h-11 border-t border-line-soft">
          <RoundBtn label="Back" onClick={onBack} disabled={!canBack}>
            <ArrowLeft className="h-4 w-4" />
          </RoundBtn>
          <RoundBtn label="Forward" onClick={onForward} disabled={!canForward}>
            <ArrowRight className="h-4 w-4" />
          </RoundBtn>
          <RoundBtn label="Reload" onClick={onReload} disabled={!canReload}>
            <RotateCw className={`h-4 w-4${loading ? " animate-spin" : ""}`} />
          </RoundBtn>
          <RoundBtn label="Browse for me" onClick={onBrowseForMe} accent>
            <Sparkles className="h-4 w-4" />
          </RoundBtn>
          <RoundBtn
            label={annotating ? "Stop annotating" : "Annotate — click page elements to attach"}
            onClick={onToggleAnnotate}
            disabled={!canAnnotate}
            active={annotating}
          >
            <MousePointerClick className="h-4 w-4" />
          </RoundBtn>
          {annotating && annotationCount > 0 && (
            <button
              type="button"
              title="Attach the marked elements to the chat"
              aria-label="Attach annotations to chat"
              onClick={onAttachAnnotations}
              className="flex items-center gap-1.5 h-9 px-3 rounded-full bg-accent text-[color:var(--color-accent-foreground)] text-[12px] font-medium hover:bg-accent/90 transition-colors"
            >
              <MessageSquarePlus className="h-4 w-4" />
              Attach {annotationCount}
            </button>
          )}
        </div>
      )}

      {/* Primary row. */}
      <div className="flex items-center justify-between h-14 px-6 border-t border-line-soft">
        <button
          type="button"
          onClick={onToggleTabs}
          title="Tabs"
          aria-label="Tabs"
          className="relative flex items-center justify-center w-10 h-10 rounded-full text-text-2 hover:text-text-1 hover:bg-bg-3 transition-colors"
        >
          <SquareStack className="h-[18px] w-[18px]" />
          {tabCount > 1 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 flex items-center justify-center rounded-full bg-accent text-[color:var(--color-accent-foreground)] text-[9px] font-semibold leading-none">
              {tabCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={onNewTab}
          title="New tab"
          aria-label="New tab"
          className="flex items-center justify-center h-11 w-16 rounded-full bg-bg-3 text-text-1 hover:bg-bg-3/80 border border-line-soft shadow-sm transition-colors"
        >
          <Plus className="h-5 w-5" />
        </button>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Hide controls" : "More controls"}
          aria-label={expanded ? "Hide controls" : "More controls"}
          aria-pressed={expanded}
          className={`flex items-center justify-center w-10 h-10 rounded-full transition-colors ${
            expanded ? "bg-bg-3 text-text-1" : "text-text-2 hover:text-text-1 hover:bg-bg-3"
          }`}
        >
          <ChevronUp
            className={`h-[18px] w-[18px] transition-transform${expanded ? " rotate-180" : ""}`}
          />
        </button>
      </div>
    </div>
  );
}

function EngineSlot({
  kind,
  active,
  onClick,
}: {
  kind: "aura" | "google";
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={kind === "aura" ? "Aura — Browse for me" : "Google search"}
      aria-label={kind === "aura" ? "Aura" : "Google"}
      aria-pressed={active}
      className={`flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold transition-colors ${
        active
          ? kind === "aura"
            ? "bg-accent text-[color:var(--color-accent-foreground)]"
            : "bg-bg-1 text-text-1 ring-1 ring-line-strong"
          : "text-text-4 hover:text-text-2"
      }`}
    >
      {kind === "aura" ? <Sparkles className="h-3.5 w-3.5" /> : "G"}
    </button>
  );
}

function RoundBtn({
  label,
  onClick,
  disabled,
  accent,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center w-9 h-9 rounded-full transition-colors disabled:opacity-40 disabled:pointer-events-none ${
        active
          ? "bg-accent text-[color:var(--color-accent-foreground)]"
          : accent
            ? "text-accent hover:bg-bg-3"
            : "text-text-2 hover:text-text-1 hover:bg-bg-3"
      }`}
    >
      {children}
    </button>
  );
}
