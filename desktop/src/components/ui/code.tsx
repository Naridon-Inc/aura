import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
export interface CodeProps extends HTMLAttributes<HTMLElement> {
  size?: "sm" | "default";
  nowrap?: boolean;
}
export const codeVariants = ({ className }: { className?: string } = {}) =>
  cn("ui-code", className);
export const Code = forwardRef<HTMLElement, CodeProps>(
  ({ className, size = "default", nowrap = true, ...props }, ref) => (
    <code
      ref={ref}
      className={cn(
        codeVariants(),
        size === "sm" && "ui-code-small",
        nowrap && "whitespace-nowrap",
        className,
      )}
      {...props}
    />
  ),
);
Code.displayName = "Code";
