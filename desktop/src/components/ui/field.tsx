// Field — the form-row wrapper the old hand-rolled modals never had: a label
// (with optional/hint passthrough), the control as children, and a single
// slot under it for either a muted description or a red error message. Keeps
// every form row on the same rhythm (Medusa's 8px label→control→help stack).

import * as React from "react";

import { cn } from "../../lib/utils";
import { Label } from "./label";

export interface FieldProps {
  /** Label text. Omit for control-only rows (e.g. a bare toggle line). */
  label?: React.ReactNode;
  /** Associates the label with the control. */
  htmlFor?: string;
  /** Muted "(Optional)" marker on the label. */
  optional?: boolean;
  /** Info-icon tooltip on the label. */
  hint?: React.ReactNode;
  /** Muted help text under the control (hidden when `error` is set). */
  description?: React.ReactNode;
  /** Red error text under the control; takes precedence over description. */
  error?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function Field({
  label,
  htmlFor,
  optional,
  hint,
  description,
  error,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {label != null && (
        <Label htmlFor={htmlFor} optional={optional} hint={hint}>
          {label}
        </Label>
      )}
      {children}
      {error != null ? (
        <p className="text-[13px] leading-[20.8px] text-red-400">{error}</p>
      ) : description != null ? (
        <p className="text-[13px] leading-[20.8px] text-text-3">{description}</p>
      ) : null}
    </div>
  );
}
