import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Root, Thumb } from "@radix-ui/react-switch";
import { cn } from "../../lib/utils";
type SwitchProps = ComponentPropsWithoutRef<typeof Root> & { size?: "small" | "base" };
export const Switch = forwardRef<ElementRef<typeof Root>, SwitchProps>(
  ({ className, size = "base", ...props }, ref) => (
    <Root
      ref={ref}
      className={cn("ui-switch", size === "small" && "ui-switch-small", className)}
      {...props}
    >
      <Thumb className="ui-switch-thumb" />
    </Root>
  ),
);
Switch.displayName = "Switch";
