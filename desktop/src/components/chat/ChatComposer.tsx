import { type ComponentPropsWithoutRef, type HTMLAttributes, type ReactNode } from "react";
import { Check, ChevronDown, ListTodo, MessageSquare, SlidersHorizontal, Terminal, Route } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import "./ChatComposer.css";

// Share the dropdowns' Radix layer registry: a nested menu consumes Escape
// before the options panel, and restores focus to its own trigger.
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
function PopoverContent(props: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  return <PopoverPrimitive.Portal><PopoverPrimitive.Content {...props} style={{ zIndex: 60, ...props.style }} /></PopoverPrimitive.Portal>;
}

export type ChatMode = "auto" | "build" | "plan" | "ask";
const MODES = [
  { value: "build" as const, label: "Agent", description: "Edit files and run tools", icon: Terminal },
  { value: "plan" as const, label: "Plan", description: "Plan changes before building", icon: ListTodo },
  { value: "ask" as const, label: "Ask", description: "Explore without changing files", icon: MessageSquare },
  { value: "auto" as const, label: "Auto", description: "Let Aura choose the mode", icon: Route },
];

/** Shared geometry and focus treatment for every conversation composer. */
export function ComposerFrame({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`composer unified-composer ${className}`} />;
}

export function ComposerToolbar({ mode, model, options, actions }: { mode?: ReactNode; model?: ReactNode; options?: ReactNode; actions?: ReactNode }) {
  return <div className="unified-composer-toolbar">
    <div className="unified-composer-selectors">{mode}{model}</div>
    <div className="unified-composer-actions">
      {options && <Popover><PopoverTrigger asChild><button type="button" className="composer-control-icon" aria-label="Chat options" title="Chat options"><SlidersHorizontal size={15} /></button></PopoverTrigger><PopoverContent align="end" side="top" className="chat-menu-surface unified-composer-options" sideOffset={8} collisionPadding={12}><div className="composer-menu-heading">Chat options</div>{options}</PopoverContent></Popover>}
      {actions}
    </div>
  </div>;
}

export function ChatModePicker({ value, onChange, disabled, modes = ["build", "plan", "ask", "auto"] }: { value: ChatMode; onChange: (mode: ChatMode) => void; disabled?: boolean; modes?: ChatMode[] }) {
  const active = MODES.find(m => m.value === value) ?? MODES[0];
  const Icon = active.icon;
  return <DropdownMenu><DropdownMenuTrigger asChild>
    <button type="button" className={`composer-selector ${value === "plan" ? "is-plan" : ""}`} disabled={disabled || modes.length < 2} aria-label={`Chat mode: ${active.label}`} title={active.description}><Icon size={14} /><span>{active.label}</span>{modes.length > 1 && <ChevronDown size={12} />}</button>
  </DropdownMenuTrigger><DropdownMenuContent align="start" side="top" className="chat-menu-surface composer-mode-menu" sideOffset={8} collisionPadding={12}>
    <div className="chat-menu-title">Work mode</div>
    {MODES.filter(m => modes.includes(m.value)).map(m => <DropdownMenuItem key={m.value} role="menuitemradio" aria-checked={value === m.value} textValue={m.label} data-selected={value === m.value} onSelect={() => onChange(m.value)} className="composer-mode-option"><span className="chat-menu-glyph"><m.icon size={16} /></span><span className="chat-menu-copy"><strong>{m.label}</strong><small>{m.description}</small></span>{value === m.value && <Check size={14} className="chat-menu-check" />}</DropdownMenuItem>)}
  </DropdownMenuContent></DropdownMenu>;
}

/** Native CLI names are not a fixed allowlist. An override is submitted only
 * after Apply; closing this popover leaves the current model untouched. */
/** Modes steer the next request; permissions continue to be enforced by the
 * selected transport. No mode silently grants broader execution rights. */
export function promptForChatMode(text: string, mode: ChatMode): string {
  if (mode === "plan") return `Plan mode: investigate and propose a concrete plan. Do not edit files or run commands that change state. Wait for my instruction before implementation.\n\n${text}`;
  if (mode === "ask") return `Ask mode: answer this question using read-only investigation. Do not edit files or run commands that change state.\n\n${text}`;
  return text;
}
