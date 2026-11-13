// The diff pane's header tools, left to right: Discard changes, the
// Unified / Split view switch, hide whitespace, wrap lines. Each is a small
// ghost icon with its name on hover; a pressed toggle keeps the hover fill.
// The view, whitespace and wrap choices are shared preferences, so flipping
// one here flips every open diff.

import { Columns2, FileText, Pilcrow, TextAlignStart, TextWrap, Undo2 } from "lucide-react";
import type { ReactNode } from "react";

import type { DiffView } from "../../lib/diffViewPref";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";

/** How the pane shows the file: one of the two diff layouts, or the whole
 *  file with no diff drawn ("raw"). Only the diff layouts are remembered. */
export type PaneView = DiffView | "raw";

const VIEWS: { value: PaneView; label: string; icon: ReactNode }[] = [
  { value: "unified", label: "Unified view", icon: <TextAlignStart /> },
  { value: "split", label: "Split view", icon: <Columns2 /> },
  { value: "raw", label: "Entire file", icon: <FileText /> },
];

export function DiffPaneTools({
  view,
  onView,
  canSplit,
  canRaw = false,
  hideWhitespace,
  onHideWhitespace,
  wrapLines,
  onWrapLines,
  onDiscard,
}: {
  view: PaneView;
  onView: (v: PaneView) => void;
  /** A one-sided diff (a new or deleted file) has nothing to put side by
   *  side, so Split view is left out. */
  canSplit: boolean;
  /** Whether the file as it is now could be read, for Entire file. */
  canRaw?: boolean;
  hideWhitespace: boolean;
  onHideWhitespace: (on: boolean) => void;
  wrapLines: boolean;
  onWrapLines: (on: boolean) => void;
  /** Left out when there is nothing to throw away. */
  onDiscard?: () => void;
}) {
  // Whitespace and wrapping are options of the side-by-side editor; the
  // inline view always wraps and shows the patch exactly as git wrote it.
  const split = view === "split";
  const views = VIEWS.filter(
    (v) => (v.value !== "split" || canSplit) && (v.value !== "raw" || canRaw),
  );
  return (
    <>
      {onDiscard && <Tool label="Discard changes" icon={<Undo2 />} onClick={onDiscard} />}
      {views.length > 1 && (
        <div className="ui-file-view-switch" role="group" aria-label="How the diff is laid out">
          {views.map((v) => (
            <Tool
              key={v.value}
              label={v.label}
              icon={v.icon}
              pressed={view === v.value}
              onClick={() => onView(v.value)}
            />
          ))}
        </div>
      )}
      {view !== "raw" && (
        <Tool
          label={hideWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          icon={<Pilcrow />}
          pressed={hideWhitespace}
          onClick={() => onHideWhitespace(!hideWhitespace)}
        />
      )}
      {split && (
        <Tool
          label={wrapLines ? "Don't wrap lines" : "Wrap lines"}
          icon={<TextWrap />}
          pressed={wrapLines}
          onClick={() => onWrapLines(!wrapLines)}
        />
      )}
    </>
  );
}

function Tool({
  label,
  icon,
  pressed,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={label}>
      <Button
        variant="ghost"
        size="iconSm"
        className="ui-file-view-tool"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {icon}
      </Button>
    </Tooltip>
  );
}
