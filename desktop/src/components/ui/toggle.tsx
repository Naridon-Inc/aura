import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Root } from "@radix-ui/react-toggle";
import { cn } from "../../lib/utils";
export type ToggleVariant = "default" | "outline" | "ghost";
export type ToggleSize = "default" | "sm" | "lg";
export const Toggle = forwardRef<
  ElementRef<typeof Root>,
  ComponentPropsWithoutRef<typeof Root> & { variant?: ToggleVariant; size?: ToggleSize }
>(({ className, variant = "default", size = "default", ...props }, ref) => (
  <Root
    ref={ref}
    className={cn("ui-toggle", `ui-toggle-${variant}`, `ui-toggle-${size}`, className)}
    {...props}
  />
));
Toggle.displayName = "Toggle";
