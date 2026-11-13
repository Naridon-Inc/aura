import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, ...props }, ref) => (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn("ui-input ui-textarea", className)}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
