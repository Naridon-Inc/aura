import * as React from "react";
import { Badge as MedusaBadge } from "@medusajs/ui";

import { cn } from "../../lib/utils";

type MedusaBadgeProps = React.ComponentPropsWithoutRef<typeof MedusaBadge>;

export type BadgeVariant = "default" | "accent" | "success" | "warn" | "muted";

export interface BadgeProps extends Omit<MedusaBadgeProps, "color"> {
  variant?: BadgeVariant;
}

const colorMap: Record<BadgeVariant, MedusaBadgeProps["color"]> = {
  default: "grey",
  accent: "blue",
  success: "green",
  warn: "orange",
  muted: "grey",
};

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = "default", size = "xsmall", rounded = "base", ...props }, ref) => (
    <MedusaBadge
      ref={ref}
      color={colorMap[variant]}
      size={size}
      rounded={rounded}
      className={cn(variant === "muted" && "opacity-70", className)}
      {...props}
    />
  ),
);
Badge.displayName = "Badge";

export const badgeVariants = ({ className }: { className?: string } = {}) => cn(className);
