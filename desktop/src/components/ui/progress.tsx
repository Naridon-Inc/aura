import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Root, Indicator } from "@radix-ui/react-progress";
import { cn } from "../../lib/utils";
export const Progress = forwardRef<ElementRef<typeof Root>, ComponentPropsWithoutRef<typeof Root>>(
  ({ className, value, max = 100, ...props }, ref) => {
    const limit = max > 0 ? max : 100;
    const normalized = value == null ? null : Math.min(limit, Math.max(0, value));
    return (
      <Root
        ref={ref}
        value={normalized}
        max={limit}
        className={cn("ui-progress", className)}
        {...props}
      >
        <Indicator
          className="ui-progress-indicator"
          style={{ width: normalized == null ? "30%" : `${(normalized / limit) * 100}%` }}
        />
      </Root>
    );
  },
);
Progress.displayName = "Progress";
