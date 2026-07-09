import * as React from "react";
import { Container, Heading } from "@medusajs/ui";

import { cn } from "../../lib/utils";

export interface CardProps extends React.ComponentPropsWithoutRef<typeof Container> {
  pad?: "none" | "sm" | "default" | "lg";
  interactive?: boolean;
}

const padClass: Record<NonNullable<CardProps["pad"]>, string> = {
  none: "p-0",
  sm: "p-2.5",
  default: "p-3",
  lg: "p-3.5",
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, pad = "default", interactive = false, ...props }, ref) => (
    <Container
      ref={ref}
      className={cn(
        padClass[pad],
        interactive && "cursor-pointer transition-fg hover:bg-ui-bg-base-hover",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export function CardTitle({ className, level = "h3", ...props }: React.ComponentPropsWithoutRef<typeof Heading>) {
  return <Heading level={level} className={cn("txt-compact-small-plus", className)} {...props} />;
}

export const cardVariants = ({ className }: { className?: string } = {}) => cn(className);
