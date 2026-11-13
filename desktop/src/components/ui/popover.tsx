import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Root, Trigger, Anchor, Content, Portal, Close } from "@radix-ui/react-popover";
import { cn } from "../../lib/utils";
import { MENU_ANIM, MENU_SURFACE_CLASS } from "./menuSurface";
import { UI_GEOMETRY } from "./geometry";
export const Popover = Root;
export const PopoverTrigger = Trigger;
export const PopoverAnchor = Anchor;
export const PopoverClose = Close;
export const PopoverContent = forwardRef<
  ElementRef<typeof Content>,
  ComponentPropsWithoutRef<typeof Content>
>(
  (
    {
      className,
      align = "center",
      sideOffset = UI_GEOMETRY.menu.sideOffset,
      collisionPadding = UI_GEOMETRY.menu.collisionPadding,
      ...props
    },
    ref,
  ) => (
    <Portal>
      <Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(MENU_SURFACE_CLASS, MENU_ANIM, "ui-popover", className)}
        {...props}
      />
    </Portal>
  ),
);
PopoverContent.displayName = "PopoverContent";
