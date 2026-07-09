import * as React from "react";
import { Button, Container, IconButton, Tooltip } from "@medusajs/ui";
import type { LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils";

export type PageActionBarAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  tooltip?: string;
};

export type PageActionBarPrimary = {
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  icon?: LucideIcon;
  disabled?: boolean;
};

export type PageActionBarProps = {
  primary?: PageActionBarPrimary;
  actions: PageActionBarAction[];
  kebab?: React.ReactNode;
  className?: string;
};

export function PageActionBar({ primary, actions, kebab, className }: PageActionBarProps) {
  const showPrimarySep = !!primary && actions.length > 0;
  const showKebabSep = !!kebab && actions.length > 0;

  return (
    <Container className={cn("flex w-fit items-center gap-1 rounded-full p-1", className)} role="toolbar">
      {primary && (
        <Button type="button" size="small" onClick={primary.onClick} disabled={primary.disabled}>
          {primary.icon && <primary.icon className="size-3.5" strokeWidth={1.6} aria-hidden />}
          {primary.label}
        </Button>
      )}
      {showPrimarySep && <span aria-hidden className="mx-1 h-5 w-px bg-ui-border-base" />}
      {actions.map((action) => (
        <ActionIconButton key={action.key} action={action} />
      ))}
      {showKebabSep && <span aria-hidden className="mx-1 h-5 w-px bg-ui-border-base" />}
      {kebab}
    </Container>
  );
}

function ActionIconButton({ action }: { action: PageActionBarAction }) {
  const { icon: Icon } = action;
  const button = (
    <IconButton
      type="button"
      size="small"
      variant={action.active ? "primary" : "transparent"}
      onClick={action.onClick}
      disabled={action.disabled}
      aria-label={action.label}
      aria-pressed={action.active ? true : undefined}
    >
      <Icon className="size-4" strokeWidth={1.6} aria-hidden />
    </IconButton>
  );

  return action.tooltip === "" ? button : <Tooltip content={action.tooltip ?? action.label}>{button}</Tooltip>;
}
