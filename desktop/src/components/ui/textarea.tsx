import * as React from "react";
import { Textarea as MedusaTextarea } from "@medusajs/ui";

import { cn } from "../../lib/utils";

type MedusaTextareaProps = React.ComponentPropsWithoutRef<typeof MedusaTextarea>;

export interface TextareaProps extends MedusaTextareaProps {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, ...props }, ref) => (
    <MedusaTextarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn("min-h-[88px]", invalid && "shadow-[var(--shadow-field-error)]", className)}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
