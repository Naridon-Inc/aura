import * as React from "react";
import { IconButton, Label as MedusaLabel, Tooltip } from "@medusajs/ui";
import { InformationCircle } from "@medusajs/icons";

import { cn } from "../../lib/utils";

export interface LabelProps extends React.ComponentPropsWithoutRef<typeof MedusaLabel> {
  optional?: boolean;
  hint?: React.ReactNode;
}

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, children, optional, hint, size = "base", weight = "plus", ...props }, ref) => (
    <MedusaLabel
      ref={ref}
      size={size}
      weight={weight}
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    >
      <span>{children}</span>
      {optional && <span className="font-normal text-text-3">(Optional)</span>}
      {hint != null && (
        <Tooltip content={hint} side="top" className="max-w-[220px]">
          <IconButton
            type="button"
            size="small"
            variant="transparent"
            tabIndex={-1}
            aria-label="More information"
            className="size-4"
          >
            <InformationCircle className="size-3" aria-hidden />
          </IconButton>
        </Tooltip>
      )}
    </MedusaLabel>
  ),
);
Label.displayName = "Label";
