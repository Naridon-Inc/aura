// Compact menu surfaces with one-level Escape dismissal.
import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  MENU_ANIM,
  MENU_INDICATOR,
  MENU_LABEL,
  MENU_PANEL,
  MENU_ROW,
  MENU_ROW_DANGER,
  MENU_ROW_INDICATED,
  MENU_SEP,
  MENU_SHORTCUT,
} from "./menuSurface";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSubState = React.createContext<{
  close: () => void;
  trigger: React.RefObject<HTMLDivElement | null>;
} | null>(null);
function DropdownMenuSub({
  open,
  defaultOpen,
  onOpenChange,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Sub>) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen ?? false);
  const trigger = React.useRef<HTMLDivElement>(null);
  const change = (value: boolean) => {
    setLocalOpen(value);
    onOpenChange?.(value);
  };
  return (
    <DropdownMenuSubState.Provider
      value={{
        trigger,
        close: () => {
          change(false);
          trigger.current?.focus();
        },
      }}
    >
      <DropdownMenuPrimitive.Sub {...props} open={open ?? localOpen} onOpenChange={change}>
        {children}
      </DropdownMenuPrimitive.Sub>
    </DropdownMenuSubState.Provider>
  );
}
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const panelBase = `${MENU_PANEL} ${MENU_ANIM}`;

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
    /** What closes the row. Menus default to the chevron; a menu with its
     *  own row family (the composer's ＋ menu) passes its own mark. */
    indicator?: React.ReactNode;
  }
>(({ className, inset, children, indicator, ...props }, ref) => {
  const submenu = React.useContext(DropdownMenuSubState);
  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={(element) => {
        if (submenu) submenu.trigger.current = element;
        if (typeof ref === "function") return ref(element);
        if (ref) ref.current = element;
      }}
      className={cn(
        MENU_ROW,
        "data-[state=open]:bg-bg-2 data-[state=open]:text-text-1",
        inset && MENU_ROW_INDICATED,
        className,
      )}
      {...props}
    >
      {children}
      {indicator ?? <ChevronRight className="ml-auto h-4 w-4 text-text-4" />}
    </DropdownMenuPrimitive.SubTrigger>
  );
});
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, onEscapeKeyDown, ...props }, ref) => {
  const submenu = React.useContext(DropdownMenuSubState);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        ref={ref}
        className={cn(panelBase, className)}
        {...props}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          if (!event.defaultPrevented && submenu) {
            event.preventDefault();
            event.stopImmediatePropagation();
            submenu.close();
          }
        }}
      />
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(panelBase, className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
    variant?: "default" | "destructive";
  }
>(({ className, inset, variant = "default", ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    data-variant={variant}
    className={cn(
      MENU_ROW,
      inset && MENU_ROW_INDICATED,
      variant === "destructive" && MENU_ROW_DANGER,
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(MENU_ROW, MENU_ROW_INDICATED, className)}
    checked={checked}
    {...props}
  >
    <span className={MENU_INDICATOR}>
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="h-4 w-4 text-text-1" strokeWidth={2.5} />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

/** A setting that is on or off, as a plain row: its children (icon and label)
 *  where every row has them, and a small switch at the end that shows the
 *  state either way, rather than a tick that only appears once it is on.
 *  Flipping it leaves the menu open, so the switch is seen to move. */
const DropdownMenuSwitchItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, onSelect, ...props }, ref) => {
  const state = checked === true ? "checked" : "unchecked";
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn(MENU_ROW, className)}
      checked={checked}
      onSelect={(event) => {
        onSelect?.(event);
        event.preventDefault();
      }}
      {...props}
    >
      {children}
      <span className="ui-switch ui-switch-small ui-menu-switch" data-state={state} aria-hidden="true">
        <span className="ui-switch-thumb" data-state={state} />
      </span>
    </DropdownMenuPrimitive.CheckboxItem>
  );
});
DropdownMenuSwitchItem.displayName = "DropdownMenuSwitchItem";

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(MENU_ROW, MENU_ROW_INDICATED, className)}
    {...props}
  >
    <span className={MENU_INDICATOR}>
      <DropdownMenuPrimitive.ItemIndicator>
        <Circle className="h-2 w-2 fill-current text-text-1" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(MENU_LABEL, inset && "pl-8", className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator ref={ref} className={cn(MENU_SEP, className)} {...props} />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

const DropdownMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn(MENU_SHORTCUT, className)} {...props} />
);
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSwitchItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
};
