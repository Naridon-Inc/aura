import { type HTMLAttributes, type Ref } from "react";
import { cn } from "../../lib/utils";
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  ref?: Ref<HTMLSpanElement>;
  variant?:
    | "default"
    | "secondary"
    | "outline"
    | "destructive"
    | "highlight"
    | "tip"
    | "tip-outline";
}
export function Badge({ variant = "default", className, ...props }: BadgeProps) {
  return <span className={cn("ui-badge", `ui-badge-${variant}`, className)} {...props} />;
}
