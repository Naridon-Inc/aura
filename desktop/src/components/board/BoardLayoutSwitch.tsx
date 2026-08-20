// The layout switch, plus the hook that remembers the choice.
//
// Plane draws every view of the same work behind one segmented control and
// treats layout as a property of the *surface you're standing in*, not a global
// setting: you might want your sprint as a board and your backlog as a list,
// and it should still be that way tomorrow. `useBoardLayout` gives each surface
// its own remembered choice, keyed by a stable surface id.
//
// Every surface's switch is THIS component. Surfaces that offer more than the
// shared pair (the Tasks board's Sprint, Crew's dependency Graph) pass their own
// `options` — exactly how Plane drives its switcher off the view's declared
// layouts — rather than hand-rolling a second control that drifts.
//
// The active segment is the one primary affordance here, so it carries the
// accent; the resting segments stay on the neutral text ramp.

import { useCallback, useEffect, useState, type JSX } from "react";
import { KanbanSquare, List as ListIcon, type LucideIcon } from "lucide-react";

/** The two layouts every work surface offers. Surfaces with extra layouts of
 *  their own declare them in their `options` and widen this union locally. */
export type BoardLayout = "list" | "board";

/** One segment of the switch. `hint` is the hover tooltip and must be plain
 *  language — it is often the only place a non-engineer learns what a layout
 *  actually gives them. */
export type BoardLayoutOption<T extends string> = {
  value: T;
  label: string;
  icon: LucideIcon;
  hint: string;
};

/** The shared pair, for surfaces that offer exactly List and Board. */
export const BOARD_LAYOUT_OPTIONS: readonly BoardLayoutOption<BoardLayout>[] = [
  {
    value: "list",
    label: "List",
    icon: ListIcon,
    hint: "See the work as one grouped list",
  },
  {
    value: "board",
    label: "Board",
    icon: KanbanSquare,
    hint: "See the work as lanes you can scan across",
  },
];

const STORAGE_PREFIX = "aura.boardLayout.";

/**
 * Remembered layout for one surface, over whatever set of layouts that surface
 * offers.
 *
 * `surfaceKey` must be stable across releases — it's the localStorage key. Pass
 * something descriptive of the *surface*, not the component ("mission",
 * "tasks", "subtasks"). `allowed` is the guard: a stored value that is no longer
 * a layout this surface offers falls back rather than rendering nothing.
 */
export function usePersistedLayout<T extends string>(
  surfaceKey: string,
  fallback: T,
  allowed: readonly T[],
): [T, (next: T) => void] {
  const read = useCallback((): T | null => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + surfaceKey);
      return raw !== null && (allowed as readonly string[]).includes(raw)
        ? (raw as T)
        : null;
    } catch {
      // Private-mode / disabled storage — the choice just won't persist.
      return null;
    }
  }, [surfaceKey, allowed]);

  const [layout, setLayout] = useState<T>(() => read() ?? fallback);

  // Re-read when the surface key changes, so a component reused across
  // surfaces (the same board rendered per project) picks up that surface's
  // remembered choice instead of carrying the previous one over.
  useEffect(() => {
    const stored = read();
    if (stored !== null) setLayout(stored);
  }, [read]);

  const choose = useCallback(
    (next: T) => {
      setLayout(next);
      try {
        localStorage.setItem(STORAGE_PREFIX + surfaceKey, next);
      } catch {
        // ignore — the switch still works for this session
      }
    },
    [surfaceKey],
  );

  return [layout, choose];
}

const SHARED_LAYOUTS: readonly BoardLayout[] = ["list", "board"];

/** Remembered layout for a surface offering exactly the shared List/Board pair. */
export function useBoardLayout(
  surfaceKey: string,
  fallback: BoardLayout = "board",
): [BoardLayout, (next: BoardLayout) => void] {
  return usePersistedLayout<BoardLayout>(surfaceKey, fallback, SHARED_LAYOUTS);
}

/**
 * The segmented switch.
 *
 * Built on the app's existing `.ade-seg ade-seg--row` markup — the same strip
 * the right rail's section tabs and the sidebar-foot switcher wear — rather
 * than a private set of classes. That is deliberate: a board's layout switch
 * and a rail's section switch are the same gesture, and one stylesheet rule
 * keeps them from drifting the way this app's boards already had. It also
 * happens to match Plane's header viewbar: a bare strip (no wrapper border or
 * fill — the header is the surface), 26px-tall segments, and the active one
 * tinted with the accent rather than outlined.
 *
 * `size="sm"` drops the text labels, leaving square icon segments, for toolbars
 * too tight to spell the words out (the tooltip and aria-label still do).
 * `shape="floating"` puts the same strip in a capsule, for surfaces that hover
 * it over a canvas rather than seating it in a header (the Figma/Miro
 * view-control convention) — same segments, same vocabulary, same active
 * treatment; only the container differs, because a control floating over a
 * canvas needs something to sit on.
 */
export function BoardLayoutSwitch<T extends string>({
  layout,
  onLayout,
  options,
  size = "md",
  shape = "inline",
  className,
}: {
  layout: T;
  onLayout: (next: T) => void;
  options: readonly BoardLayoutOption<T>[];
  size?: "sm" | "md";
  shape?: "inline" | "floating";
  className?: string;
}): JSX.Element {
  const strip = (
    <div
      className={`ade-seg ade-seg--row${size === "sm" ? " ade-seg--icon" : ""}${
        shape === "floating" ? " ade-seg--pill" : ""
      }${shape === "inline" && className ? ` ${className}` : ""}`}
      role="group"
      aria-label="Layout"
    >
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = opt.value === layout;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onLayout(opt.value)}
            aria-pressed={active}
            title={opt.hint}
            aria-label={opt.label}
            className={active ? "active" : undefined}
          >
            <Icon strokeWidth={1.5} aria-hidden />
            {size === "md" && opt.label}
          </button>
        );
      })}
    </div>
  );

  if (shape === "inline") return strip;

  return (
    <div
      className={`inline-flex rounded-full border-[0.5px] border-line-soft bg-bg-1/90 p-0.5 shadow-[var(--shadow-modal)] backdrop-blur ${
        className ?? ""
      }`}
    >
      {strip}
    </div>
  );
}
