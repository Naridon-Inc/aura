import { type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
export function Alert({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLDivElement> & { variant?: "default" | "destructive" }) {
  return (
    <div
      role="alert"
      className={cn("ui-alert", variant === "destructive" && "ui-alert-danger", className)}
      {...props}
    />
  );
}
export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className={cn("ui-alert-title", className)} {...props} />;
}
export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-alert-description", className)} {...props} />;
}
