import * as React from "react";
import { Button as MedusaButton } from "@medusajs/ui";
import { ChevronDown } from "@medusajs/icons";

import { cn } from "../../lib/utils";

export interface ChipButtonProps
  extends Omit<React.ComponentPropsWithoutRef<typeof MedusaButton>, "variant" | "size"> {
  variant?: "ghost" | "outline";
  size?: "sm" | "default";
  active?: boolean;
  chevron?: boolean;
}

export const ChipButton = React.forwardRef<HTMLButtonElement, ChipButtonProps>(
  ({ className, variant = "ghost", size = "default", active, chevron = true, children, ...props }, ref) => (
    <MedusaButton
      ref={ref}
      type="button"
      variant={variant === "outline" ? "secondary" : "transparent"}
      size="small"
      className={cn(
        size === "sm" ? "h-6 px-1.5" : "h-[26px] px-2",
        active && "bg-ui-bg-base-pressed text-ui-fg-base",
        className,
      )}
      {...props}
    >
      {children}
      {chevron && <ChevronDown className="size-3 text-ui-fg-muted" aria-hidden />}
    </MedusaButton>
  ),
);
ChipButton.displayName = "ChipButton";

export const chipVariants = ({ className }: { className?: string } = {}) => cn(className);
