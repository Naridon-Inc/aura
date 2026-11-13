import {
  createContext,
  useContext,
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";
import { Root, Item } from "@radix-ui/react-toggle-group";
import { cn } from "../../lib/utils";
import type { ToggleVariant, ToggleSize } from "./toggle";
type Appearance = { variant?: ToggleVariant; size?: ToggleSize };
const AppearanceContext = createContext<Appearance>({});
export const ToggleGroup = forwardRef<
  ElementRef<typeof Root>,
  ComponentPropsWithoutRef<typeof Root> & Appearance
>(({ className, variant = "default", size = "default", children, ...props }, ref) => (
  <AppearanceContext.Provider value={{ variant, size }}>
    <Root ref={ref} className={cn("ui-toggle-group", className)} {...props}>
      {children}
    </Root>
  </AppearanceContext.Provider>
));
ToggleGroup.displayName = "ToggleGroup";
export const ToggleGroupItem = forwardRef<
  ElementRef<typeof Item>,
  ComponentPropsWithoutRef<typeof Item> & Appearance
>(({ className, variant, size, ...props }, ref) => {
  const group = useContext(AppearanceContext);
  return (
    <Item
      ref={ref}
      className={cn(
        "ui-toggle",
        `ui-toggle-${variant ?? group.variant ?? "default"}`,
        `ui-toggle-${size ?? group.size ?? "default"}`,
        className,
      )}
      {...props}
    />
  );
});
ToggleGroupItem.displayName = "ToggleGroupItem";
