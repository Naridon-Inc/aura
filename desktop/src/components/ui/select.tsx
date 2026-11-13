import { useEffect, useState, type ReactNode } from "react";
import {
  Root,
  Trigger,
  Value,
  Icon,
  Portal,
  Content,
  Viewport,
  Item,
  ItemText,
  ItemIndicator,
  ScrollUpButton,
  ScrollDownButton,
} from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { cn } from "../../lib/utils";
/** Radix ships Select on a newer copy of its layer stack than Dialog, Sheet,
 *  Popover and the menus, so neither stack sees the other: one Escape closed an
 *  open dropdown and the dialog under it, and left the page unclickable. While
 *  a dropdown is open it takes Escape first, on the window, before either
 *  stack hears it. */
export function escapeTaker(close: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
}
export interface SelectOption {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}
export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  className?: string;
  align?: "start" | "center" | "end";
  indicator?: "both" | "down" | "none";
  "aria-label"?: string;
}
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  invalid,
  id,
  className,
  align = "start",
  indicator = "both",
  ...aria
}: SelectProps) {
  let empty = "__empty_selection__";
  while (options.some((option) => option.value === empty)) empty += "_";
  const hasEmpty = options.some((option) => option.value === "");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const take = escapeTaker(() => setOpen(false));
    window.addEventListener("keydown", take, true);
    return () => window.removeEventListener("keydown", take, true);
  }, [open]);
  return (
    <Root
      open={open}
      onOpenChange={setOpen}
      value={value === "" ? (hasEmpty ? empty : "") : value}
      onValueChange={(next) => onChange(next === empty ? "" : next)}
      disabled={disabled}
    >
      <Trigger
        id={id}
        className={cn("ui-select-trigger ade-select-trigger", className)}
        aria-invalid={invalid || undefined}
        aria-label={aria["aria-label"]}
      >
        <Value placeholder={placeholder} />
        {indicator !== "none" && (
          <Icon asChild>
            {indicator === "down" ? (
              <ChevronDown className="ade-select-caret" size={14} />
            ) : (
              <ChevronsUpDown className="ade-select-caret" size={14} />
            )}
          </Icon>
        )}
      </Trigger>
      <Portal>
        <Content
          position="popper"
          align={align}
          sideOffset={4}
          collisionPadding={8}
          className="aura-menu-surface ui-select-content"
        >
          <ScrollUpButton className="ui-select-scroll">
            <ChevronUp size={14} />
          </ScrollUpButton>
          <Viewport>
            {options.map((option) => (
              <Item
                key={option.value}
                value={option.value === "" ? empty : option.value}
                disabled={option.disabled}
                textValue={
                  typeof option.label === "string" ? option.label : option.value
                }
                className="ui-menu-row ui-select-item"
              >
                <ItemText>
                  <span className="ui-select-label">
                    {option.icon}
                    {option.label}
                  </span>
                </ItemText>
                <ItemIndicator className="ui-select-indicator">
                  <Check size={14} />
                </ItemIndicator>
              </Item>
            ))}
          </Viewport>
          <ScrollDownButton className="ui-select-scroll">
            <ChevronDown size={14} />
          </ScrollDownButton>
        </Content>
      </Portal>
    </Root>
  );
}
