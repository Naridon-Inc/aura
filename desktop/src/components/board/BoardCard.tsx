// The board card — one work item, wearing the same skin on every board in the
// app, and sharing its chip grammar with the list layout.
//
// Anatomy follows Plane's work-item card, top to bottom:
//
//   AURA-42                                       handle (smallest thing here)
//   Ship the split-diff explainer                 title (the hero)
//   ◐ In Progress  ▍▍  ⏱ tomorrow  ● design  (AB) meta: one continuous chip band
//
// Every row except the title is optional and drops out cleanly when a card has
// nothing to put there — a queued card with no agent and no commit shows a
// title and nothing else, never empty chrome.
//
// Two of Plane's decisions are load-bearing here:
//
//   • The card CRISPS on hover — border darkens a step and the shadow gets
//     tighter and darker — rather than lifting on a bigger, softer shadow. It
//     reads as focus, not elevation.
//   • One chip height, one chip radius, one hairline border weight across
//     every meta family, so the footer reads as a single band. The card's own
//     border is a full 1px — twice the chips' hairline — so the card boundary
//     always wins over the chrome inside it.
//
// The card also owns an interaction detail that was previously copy-pasted
// between boards: it opens on mousedown, not click. macOS WKWebView suppresses
// the synthetic `click` on `draggable` elements — it begins drag-tracking on
// mousedown and never dispatches the click — which left cards intermittently
// un-openable. A real drag still fires `onDragStart`.

import type { CSSProperties, JSX, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import {
  BOARD_CARD_META_ROW,
  BOARD_CARD_SHELL,
  BOARD_CARD_TITLE,
  BOARD_CHIP,
} from "./boardTokens";

/** Modifier keys read off the opening event — boards use them for range and
 *  additive multi-select. */
export type BoardCardOpenEvent = {
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
};

export function BoardCard({
  onOpen,
  selected = false,
  focused = false,
  draggable = false,
  onDragStart,
  title,
  dataAttrs,
  children,
}: {
  onOpen: (e: BoardCardOpenEvent) => void;
  /** In the bulk-selection set — accent border + ring. */
  selected?: boolean;
  /** Keyboard focus / open in the peek — Plane replaces the neutral border
   *  with an accent one, no ring. */
  focused?: boolean;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Native tooltip, usually the untruncated title. */
  title?: string;
  /** Escape hatch for `data-*` hooks the surrounding board needs (keyboard
   *  navigation scrolls the focused card into view by `data-task-id`). */
  dataAttrs?: Record<string, string>;
  children: ReactNode;
}): JSX.Element {
  const border = selected
    ? "border-accent bg-accent/[0.04] ring-1 ring-accent/50"
    : focused
      ? "border-accent"
      : "border-line-soft hover:border-line";

  return (
    <div
      role="button"
      tabIndex={0}
      title={title}
      {...dataAttrs}
      draggable={draggable}
      onDragStart={onDragStart}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        onOpen({ shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen({ shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
        }
      }}
      className={`${BOARD_CARD_SHELL} cursor-pointer ${border}`}
      style={{ boxShadow: "var(--shadow-board-card)" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = "var(--shadow-board-card-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = "var(--shadow-board-card)";
      }}
    >
      {children}
    </div>
  );
}

/** The card's top strip: handle on the left, anything pinned right via
 *  `ml-auto`. */
export function BoardCardHeader({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex items-center gap-1.5">{children}</div>;
}

/** The mono handle ("AURA-42", "run 3f2a"). The smallest thing on the card by
 *  design — it is identity, not information. */
export function BoardCardHandle({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}): JSX.Element {
  return (
    <span
      className="truncate font-mono text-xs leading-4 text-text-3"
      title={title}
    >
      {children}
    </span>
  );
}

/** The title — two-line clamp, same size and weight as the lane title above
 *  it. Plane clamps to one line; we allow two because these titles are written
 *  by and for non-engineers and are sentences, not ticket shorthand. */
export function BoardCardTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={className ? `${BOARD_CARD_TITLE} ${className}` : BOARD_CARD_TITLE}>
      {children}
    </div>
  );
}

/** The footer row. Wraps; pass the assignee slot last with `ml-auto`. */
export function BoardCardMetaRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className={BOARD_CARD_META_ROW}>{children}</div>;
}

/**
 * One meta chip — the shared 20px/6px tinted box.
 *
 * `tone` is semantic, never decorative: `alert` is the single meta that is
 * asking something of the reader (an overdue date), and it earns a red tint
 * rather than a red outline so it stays the same object as its neighbours.
 * Everything else sits on the neutral fill, because a board whose every chip
 * is tinted stops communicating anything at all.
 */
export function BoardCardMeta({
  icon: Icon,
  children,
  title,
  mono = false,
  tone,
}: {
  icon?: LucideIcon;
  children?: ReactNode;
  title?: string;
  mono?: boolean;
  tone?: "alert";
}): JSX.Element {
  return (
    <span
      className={`${BOARD_CHIP} ${
        tone === "alert" ? "bg-red/10 text-red" : "text-text-3"
      } ${mono ? "font-mono" : ""}`}
      title={title}
    >
      {Icon && (
        <Icon
          className="h-3.5 w-3.5 flex-shrink-0"
          strokeWidth={1.5}
          aria-hidden
        />
      )}
      {children}
    </span>
  );
}

/**
 * A colour-dotted label chip. The dot carries the label's colour and the text
 * stays on the neutral ramp — a wall of fully-tinted chips is what makes a
 * board look noisy, and at 11px coloured text fails contrast anyway.
 */
export function BoardCardLabel({
  name,
  color,
}: {
  name: string;
  color?: string;
}): JSX.Element {
  return (
    <span className={`${BOARD_CHIP} text-text-3`} title={name}>
      <span
        className="h-2 w-2 flex-shrink-0 rounded-full"
        style={{ background: color ?? "var(--color-text-4)" }}
        aria-hidden
      />
      <span className="max-w-[200px] truncate">{name}</span>
    </span>
  );
}

/**
 * The label row. Plane's rule exactly: up to three labels render as their own
 * chips; past that they collapse into a single "N labels" chip with an accent
 * dot, so a heavily-tagged card can never blow the footer open.
 */
export function BoardCardLabels({
  labels,
  max = 3,
}: {
  labels: { key: string; name: string; color?: string }[];
  max?: number;
}): JSX.Element | null {
  if (labels.length === 0) return null;
  if (labels.length > max) {
    return (
      <span
        className={`${BOARD_CHIP} text-text-3`}
        title={labels.map((l) => l.name).join(", ")}
      >
        <span
          className="h-2 w-2 flex-shrink-0 rounded-full bg-accent"
          aria-hidden
        />
        {labels.length} labels
      </span>
    );
  }
  return (
    <>
      {labels.map((l) => (
        <BoardCardLabel key={l.key} name={l.name} color={l.color} />
      ))}
    </>
  );
}

/**
 * Priority as Plane's ascending signal bars, inside the shared chip box.
 *
 * Deliberate deviation: Plane tints each level (red / orange / amber / blue).
 * This app reserves orange for agent identity and teal-green for status, so a
 * five-colour priority ladder would collide with both. The number of LIT bars
 * already spells out the level, so the bars stay on the neutral ramp and only
 * Urgent — the one priority that should interrupt you — spends a colour.
 */
export function BoardCardPriority({
  level,
  label,
}: {
  /** 0 = none, 1 = low, 2 = medium, 3 = high, 4 = urgent. */
  level: 0 | 1 | 2 | 3 | 4;
  label: string;
}): JSX.Element {
  const urgent = level === 4;
  const bar = (idx: 1 | 2 | 3, height: number): JSX.Element => {
    const style: CSSProperties = {
      background: urgent ? "var(--color-red)" : "var(--color-text-3)",
      opacity: urgent || level >= idx ? 1 : 0.25,
      height,
    };
    return <i className="block w-[2.5px] rounded-[1px]" style={style} />;
  };
  return (
    <span
      className={`${BOARD_CHIP} justify-center px-1.5 ${
        urgent ? "bg-red/10" : ""
      }`}
      title={`Priority: ${label}`}
      aria-label={`${label} priority`}
    >
      <span className="inline-flex items-end gap-[1.5px]">
        {bar(1, 4)}
        {bar(2, 7)}
        {bar(3, 10)}
      </span>
    </span>
  );
}
