import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Root, Viewport, Scrollbar, Thumb, Corner } from "@radix-ui/react-scroll-area";
import { cn } from "../../lib/utils";
export const ScrollBar = forwardRef<
  ElementRef<typeof Scrollbar>,
  ComponentPropsWithoutRef<typeof Scrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <Scrollbar
    ref={ref}
    orientation={orientation}
    className={cn("ui-scrollbar", className)}
    {...props}
  >
    <Thumb className="ui-scroll-thumb" />
  </Scrollbar>
));
ScrollBar.displayName = "ScrollBar";
export const ScrollArea = forwardRef<
  ElementRef<typeof Root>,
  ComponentPropsWithoutRef<typeof Root> & { viewportClassName?: string; horizontal?: boolean }
>(({ className, children, viewportClassName, horizontal, ...props }, ref) => (
  <Root ref={ref} className={cn("ui-scroll-area", className)} {...props}>
    <Viewport className={cn("ui-scroll-viewport", viewportClassName)}>{children}</Viewport>
    <ScrollBar />
    {horizontal && <ScrollBar orientation="horizontal" />}
    <Corner />
  </Root>
));
ScrollArea.displayName = "ScrollArea";
