import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix" | "size"> {
  prefix?: ReactNode;
  suffix?: ReactNode;
  invalid?: boolean;
  size?: "small" | "base";
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, prefix, suffix, invalid, size = "base", disabled, ...props }, ref) => {
    const input = (
      <input
        ref={ref}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={
          prefix != null || suffix != null
            ? "ui-input-inner"
            : cn("ui-input", size === "small" && "ui-input-small", className)
        }
        {...props}
      />
    );
    if (prefix == null && suffix == null) return input;
    return (
      <div
        className={cn("ui-input ui-input-group", size === "small" && "ui-input-small", className)}
        data-disabled={disabled || undefined}
        data-invalid={invalid || undefined}
      >
        {prefix != null && <span className="ui-input-adornment">{prefix}</span>}
        {input}
        {suffix != null && <span className="ui-input-adornment">{suffix}</span>}
      </div>
    );
  },
);
Input.displayName = "Input";
