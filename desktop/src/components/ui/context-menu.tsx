// Compact menu surfaces with one-level Escape dismissal.
import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
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

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuPortal = ContextMenuPrimitive.Portal;
const ContextMenuSubState = React.createContext<{
  close: () => void;
  trigger: React.RefObject<HTMLDivElement | null>;
} | null>(null);
function ContextMenuSub({
  open,
  defaultOpen,
  onOpenChange,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Sub>) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen ?? false);
  const trigger = React.useRef<HTMLDivElement>(null);
  const change = (value: boolean) => {
    setLocalOpen(value);
    onOpenChange?.(value);
  };
  return (
    <ContextMenuSubState.Provider
      value={{
        trigger,
        close: () => {
          change(false);
          trigger.current?.focus();
        },
      }}
    >
      <ContextMenuPrimitive.Sub {...props} open={open ?? localOpen} onOpenChange={change}>
        {children}
      </ContextMenuPrimitive.Sub>
    </ContextMenuSubState.Provider>
  );
}
const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

const panelBase = `${MENU_PANEL} ${MENU_ANIM}`;

const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => {
  const submenu = React.useContext(ContextMenuSubState);
  return (
    <ContextMenuPrimitive.SubTrigger
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
      <ChevronRight className="ml-auto h-4 w-4 text-text-4" />
    </ContextMenuPrimitive.SubTrigger>
  );
});
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, onEscapeKeyDown, ...props }, ref) => {
  const submenu = React.useContext(ContextMenuSubState);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
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
    </ContextMenuPrimitive.Portal>
  );
});
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content ref={ref} className={cn(panelBase, className)} {...props} />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean;
    variant?: "default" | "destructive";
  }
>(({ className, inset, variant = "default", ...props }, ref) => (
  <ContextMenuPrimitive.Item
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
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <ContextMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(MENU_ROW, MENU_ROW_INDICATED, className)}
    checked={checked}
    {...props}
  >
    <span className={MENU_INDICATOR}>
      <ContextMenuPrimitive.ItemIndicator>
        <Check className="h-4 w-4 text-text-1" strokeWidth={2.5} />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.CheckboxItem>
));
ContextMenuCheckboxItem.displayName = ContextMenuPrimitive.CheckboxItem.displayName;

const ContextMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.RadioItem
    ref={ref}
    className={cn(MENU_ROW, MENU_ROW_INDICATED, className)}
    {...props}
  >
    <span className={MENU_INDICATOR}>
      <ContextMenuPrimitive.ItemIndicator>
        <Circle className="h-2 w-2 fill-current text-text-1" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.RadioItem>
));
ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName;

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn(MENU_LABEL, inset && "pl-8", className)}
    {...props}
  />
));
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator ref={ref} className={cn(MENU_SEP, className)} {...props} />
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

const ContextMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn(MENU_SHORTCUT, className)} {...props} />
);
ContextMenuShortcut.displayName = "ContextMenuShortcut";

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
};
