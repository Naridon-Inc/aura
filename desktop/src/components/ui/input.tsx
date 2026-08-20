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

    // With a prefix or suffix the FIELD is this row: it owns the background,
    // the border and the focus ring, and the control inside owns nothing but
    // the text. Composing Medusa's `Input` here drew a second field inside the
    // first — its own border at rest, its own ring on focus, its own red on
    // invalid — so a focused search box showed two stacked outlines. It also
    // wraps the element in a `div` we can't reach, which swallowed `flex-1`
    // and left the text control refusing to fill the row.
    return (
      <div
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md bg-state-hover px-2 shadow-borders-base transition-fg focus-within:shadow-borders-interactive-with-active",
          size === "small" ? "h-7" : "h-8",
          invalid && "shadow-[var(--shadow-field-error)]",
          className,
        )}
      >
        {prefix != null && <span className="shrink-0 select-none text-text-3">{prefix}</span>}
        <input
          ref={ref}
          aria-invalid={invalid || undefined}
          className="txt-compact-small h-full min-w-0 flex-1 appearance-none bg-transparent p-0 text-ui-fg-base caret-ui-fg-base outline-none placeholder-ui-fg-muted disabled:cursor-not-allowed disabled:text-ui-fg-disabled"
          {...props}
        />
        {suffix != null && <span className="shrink-0 select-none text-text-3">{suffix}</span>}
      </div>
    );
  },
);
Input.displayName = "Input";
