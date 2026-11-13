import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type RefObject,
} from "react";
import { Root, Trigger, Content, Portal } from "@radix-ui/react-hover-card";
import { cn } from "../../lib/utils";
import { MENU_SURFACE_CLASS, MENU_ANIM } from "./menuSurface";
import { rowShowing, watchHoverDismiss } from "../../lib/hoverDismiss";
export const HoverCard = Root;
export const HoverCardTrigger = Trigger;
export const HoverCardContent = forwardRef<
  ElementRef<typeof Content>,
  ComponentPropsWithoutRef<typeof Content>
>(({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <Portal>
    <Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(MENU_SURFACE_CLASS, MENU_ANIM, "ui-popover ui-hover-card", className)}
      {...props}
    />
  </Portal>
));
HoverCardContent.displayName = "HoverCardContent";

/** How often an open card checks that its row is still on screen. */
const ROW_CHECK_MS = 300;

/**
 * Open state for a hover card that also closes when its row goes away.
 *
 * Radix closes a card on pointer-leave and on an outside click. A row that is
 * hidden, scrolled off or covered by another page with the pointer still
 * gets neither, and its card stays up over whatever is showing now. Spread
 * `open`/`onOpenChange` on the `HoverCard` and put `triggerRef` on its
 * `HoverCardTrigger`: while the card is open its row is watched, and the card
 * closes on a scroll outside it, the window losing focus or going hidden, a
 * route change, or the row no longer being seen. Unmounting the row stops
 * the watch.
 */
export function useHoverCardDismiss(): {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<ElementRef<typeof Trigger> | null>;
} {
  const [open, setOpen] = useState(false);
  // Typed as Radix's trigger; with `asChild` it is whatever row element the
  // trigger wraps, and only its box and its children are read.
  const triggerRef = useRef<ElementRef<typeof Trigger>>(null);
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    return watchHoverDismiss({
      close: () => setOpen(false),
      isShowing: () =>
        rowShowing(triggerRef.current, {
          width: window.innerWidth,
          height: window.innerHeight,
          elementFromPoint: (x, y) => document.elementFromPoint(x, y),
        }),
      inCard: (target) => target instanceof Element && !!target.closest(".ui-hover-card"),
      win: window,
      doc: document,
      every: (check) => {
        const id = window.setInterval(check, ROW_CHECK_MS);
        return () => window.clearInterval(id);
      },
    });
  }, [open]);
  return { open, onOpenChange: setOpen, triggerRef };
}
