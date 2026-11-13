import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Root } from "@radix-ui/react-separator";
import { cn } from "../../lib/utils";
export const Separator = forwardRef<ElementRef<typeof Root>, ComponentPropsWithoutRef<typeof Root>>(
  ({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
    <Root
      ref={ref}
      className={cn("ui-separator", className)}
      orientation={orientation}
      decorative={decorative}
      {...props}
    />
  ),
);
Separator.displayName = "Separator";
