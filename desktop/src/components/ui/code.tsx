import * as React from "react";
import { Code as MedusaCode } from "@medusajs/ui";

import { cn } from "../../lib/utils";

export interface CodeProps extends React.ComponentPropsWithoutRef<typeof MedusaCode> {
  size?: "sm" | "default";
  nowrap?: boolean;
}

export const Code = React.forwardRef<HTMLElement, CodeProps>(
  ({ className, size = "default", nowrap = true, ...props }, ref) => (
    <MedusaCode
      ref={ref}
      className={cn(size === "sm" && "txt-compact-xsmall", nowrap && "whitespace-nowrap", className)}
      {...props}
    />
  ),
);
Code.displayName = "Code";

export const codeVariants = ({ className }: { className?: string } = {}) => cn(className);
