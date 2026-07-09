import * as React from "react";
import { Container, IconButton, Tooltip } from "@medusajs/ui";
import type { LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils";

export type FloatingPillProps = {
  children: React.ReactNode;
  sticky?: boolean;
  className?: string;
  innerClassName?: string;
};

export function FloatingPill({ children, sticky = true, className, innerClassName }: FloatingPillProps) {
  return (
    <div className={cn(sticky && "sticky top-0 z-10 flex justify-center", className)}>
      <Container className={cn("flex items-center gap-1 rounded-full p-1", innerClassName)} role="toolbar">
        {children}
      </Container>
    </div>
  );
}

export type PillButtonProps = {
  icon: LucideIcon;
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  tooltip?: string;
  className?: string;
};

export function PillButton({ icon: Icon, label, onClick, active, disabled, tooltip, className }: PillButtonProps) {
  const button = (
    <IconButton
      type="button"
      size="small"
      variant={active ? "primary" : "transparent"}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active ? true : undefined}
      className={className}
    >
      <Icon className="size-4" strokeWidth={1.6} aria-hidden />
    </IconButton>
  );

  return tooltip === "" ? button : <Tooltip content={tooltip ?? label}>{button}</Tooltip>;
}

export function PillSeparator() {
  return <span aria-hidden className="h-5 w-px bg-ui-border-base" />;
}
