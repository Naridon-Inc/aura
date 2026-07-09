import * as React from "react";
import { Copy as MedusaCopy } from "@medusajs/ui";

export interface CopyButtonProps
  extends Omit<React.ComponentPropsWithoutRef<typeof MedusaCopy>, "variant"> {
  variant?: "default" | "mini";
  onCopied?: () => void;
}

export const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  ({ onCopied, onClick, ...props }, ref) => (
    <MedusaCopy
      ref={ref}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCopied?.();
      }}
      {...props}
    />
  ),
);
CopyButton.displayName = "CopyButton";
