import * as React from "react";
import { Input as MedusaInput } from "@medusajs/ui";

import { cn } from "../../lib/utils";

type MedusaInputProps = React.ComponentPropsWithoutRef<typeof MedusaInput>;

export interface InputProps extends Omit<MedusaInputProps, "prefix" | "size"> {
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  invalid?: boolean;
  size?: MedusaInputProps["size"];
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, prefix, suffix, invalid, size = "base", ...props }, ref) => {
    if (prefix == null && suffix == null) {
      return (
        <MedusaInput
          ref={ref}
          size={size}
          aria-invalid={invalid || undefined}
          className={cn(invalid && "shadow-[var(--shadow-field-error)]", className)}
          {...props}
        />
      );
    }

    return (
      <div
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md bg-ui-bg-field px-2 shadow-borders-base transition-fg focus-within:shadow-borders-interactive-with-active",
          size === "small" ? "h-7" : "h-8",
          invalid && "shadow-[var(--shadow-field-error)]",
          className,
        )}
      >
        {prefix != null && <span className="shrink-0 select-none text-ui-fg-muted">{prefix}</span>}
        <MedusaInput
          ref={ref}
          size={size}
          aria-invalid={invalid || undefined}
          className="h-full min-w-0 flex-1 bg-transparent px-0 shadow-none"
          {...props}
        />
        {suffix != null && <span className="shrink-0 select-none text-ui-fg-muted">{suffix}</span>}
      </div>
    );
  },
);
Input.displayName = "Input";
