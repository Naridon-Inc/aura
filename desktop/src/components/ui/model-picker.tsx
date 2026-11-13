import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CornerDownLeft,
  GripVertical,
  Plus,
  Search,
  Settings,
  Zap,
} from "lucide-react";
import { AgentIcon } from "./agent-icon";
import { Kbd } from "./kbd";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./dialog";
import { Input } from "./input";
import { usePointerDrag } from "./use-pointer-drag";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuCheckboxItem,
} from "./dropdown-menu";

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  icon?: ReactNode;
  description?: string;
  shortcut?: string;
  newChat?: boolean;
  preferredEffort?: string;
  disabled?: boolean;
  efforts?: string[];
  fast?: boolean;
}
export interface ModelSelection {
  model: string;
  effort?: string;
  fast?: boolean;
}
export function ModelPicker({
  models,
  value,
  onChange,
  visibleIds,
  onVisibleChange,
  onReorder,
  onEdit,
  shortcuts = false,
  open: openProp,
  onOpenChange,
  disabled,
  onCustomModel,
}: {
  models: ModelOption[];
  value: ModelSelection;
  onChange: (selection: ModelSelection) => void;
  visibleIds?: string[];
  onVisibleChange?: (ids: string[]) => void;
  onReorder?: (ids: string[]) => void;
  onEdit?: () => void;
  shortcuts?: boolean;
  /** Held by the host when something other than the trigger opens the menu. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  /** Takes a model id typed into the search that no row lists. */
  onCustomModel?: (id: string) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const [manage, setManage] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const openingManager = useRef(false);
  const editModels = () => {
    openingManager.current = true;
  };
  const panel = useRef<HTMLDivElement>(null);
  const selected = models.find((model) => model.id === value.model);
  const visible = models.filter(
    (model) =>
      (!visibleIds || visibleIds.includes(model.id) || model.id === value.model) &&
      `${model.name} ${model.provider}`.toLowerCase().includes(query.toLowerCase()),
  );
  useEffect(() => {
    if (!shortcuts) return;
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (["/", "?"].includes(event.key) && selected?.efforts?.length) {
        event.preventDefault();
        const efforts = selected.efforts;
        onChange({
          ...value,
          effort: efforts[(efforts.indexOf(value.effort ?? "") + 1) % efforts.length],
        });
      } else if (event.key.toLowerCase() === "e" && selected?.fast) {
        event.preventDefault();
        onChange({ ...value, fast: !value.fast });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [shortcuts, selected, value, onChange]);
  const move = (from: string, to: string) => {
    const ids = models.map((model) => model.id);
    const a = ids.indexOf(from),
      b = ids.indexOf(to);
    if (a < 0 || b < 0 || a === b) return;
    ids.splice(a, 1);
    ids.splice(b, 0, from);
    onReorder?.(ids);
  };
  // Pointer-driven: the desktop app's web view never delivers an HTML5 drop.
  // A press that does not travel is still a press, so it picks the model.
  const drag = usePointerDrag<string>((from, to) => move(from, to));
  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="ui-model-trigger"
            ref={trigger}
            disabled={disabled}
            aria-label={`Change agent (${selected?.name ?? "Choose model"}${value.effort ? ` · ${value.effort}` : ""})`}
          >
            <span className="ui-model-compact-icon">
              {selected?.icon ?? <AgentIcon provider={selected?.provider ?? ""} />}
            </span>
            <span>{selected?.name ?? "Choose model"}</span>
            {value.effort && <small>{value.effort}</small>}
            {value.fast && <Zap size={12} aria-label="Fast mode" />}
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          ref={panel}
          className="ui-model-menu"
          side="top"
          align="start"
          sideOffset={6}
          onCloseAutoFocus={() => {
            setQuery("");
            if (openingManager.current) {
              openingManager.current = false;
              if (onEdit) queueMicrotask(onEdit);
              else setManage(true);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === "ArrowUp" &&
              document.activeElement === panel.current?.querySelector('[role="menuitem"]')
            ) {
              event.preventDefault();
              search.current?.focus();
            }
          }}
        >
          <div className="ui-model-menu-surface">
            <div className="ui-model-search">
              <Search size={14} />
              <input
                ref={search}
                autoFocus
                placeholder="Search models"
                aria-label="Search models"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    panel.current
                      ?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')
                      ?.focus();
                  }
                }}
              />
            </div>
            <div className="ui-model-options">
              {visible.map((model) => (
                <DropdownMenuItem
                  key={model.id}
                  className="ui-model-option"
                  disabled={model.disabled}
                  {...(onReorder && (!visibleIds || visibleIds.includes(model.id))
                    ? { ...drag.source(model.id), ...drag.target(model.id) }
                    : {})}
                  onKeyDown={(event) => {
                    if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
                      event.preventDefault();
                      event.stopPropagation();
                      const index = visible.indexOf(model) + (event.key === "ArrowUp" ? -1 : 1);
                      if (visible[index]) move(model.id, visible[index].id);
                    }
                  }}
                  onSelect={() =>
                    onChange({
                      model: model.id,
                      effort: model.efforts?.includes(value.effort ?? "")
                        ? value.effort
                        : model.efforts?.[0],
                      fast: model.fast ? value.fast : undefined,
                    })
                  }
                >
                  {onReorder && (!visibleIds || visibleIds.includes(model.id)) ? (
                    <GripVertical className="ui-model-grip" size={12} />
                  ) : (
                    <span className="ui-model-grip-spacer" />
                  )}
                  {model.icon ?? <AgentIcon provider={model.provider} />}
                  <span className="ui-model-name">
                    {model.name}
                    {model.preferredEffort && model.id !== value.model && (
                      <small> {model.preferredEffort}</small>
                    )}
                  </span>
                  {model.id === value.model ? (
                    <Check size={14} />
                  ) : (
                    <small>
                      {model.newChat ? (
                        <ArrowUpRight size={14} aria-label="Opens in new chat" />
                      ) : (
                        model.shortcut
                      )}
                    </small>
                  )}
                </DropdownMenuItem>
              ))}
              {onCustomModel && query.trim() && !models.some((model) => model.id === query.trim()) ? (
                <DropdownMenuItem
                  className="ui-model-option"
                  onSelect={() => onCustomModel(query.trim())}
                >
                  <span className="ui-model-grip-spacer" />
                  <CornerDownLeft size={16} />
                  <span className="ui-model-name">Use {query.trim()}</span>
                </DropdownMenuItem>
              ) : (
                !visible.length && <div className="ui-pattern-empty">No models found.</div>
              )}
            </div>
            {(onVisibleChange || onEdit) && (!visibleIds || visibleIds.length < 3) && (
              <DropdownMenuItem className="ui-model-add" onSelect={editModels}>
                <Plus />
                <span>Add models</span>
                <ArrowUpRight size={14} />
              </DropdownMenuItem>
            )}
            {!!selected?.efforts?.length && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    Effort <span className="ui-menu-value">{value.effort}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent sideOffset={6}>
                    {selected.efforts.map((effort) => (
                      <DropdownMenuItem
                        key={effort}
                        onSelect={(event) => {
                          event.preventDefault();
                          onChange({ ...value, effort });
                        }}
                      >
                        <span>{effort}</span>
                        {effort === value.effort && <Check size={14} />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
            {selected?.fast && (
              <DropdownMenuCheckboxItem
                className="ui-model-fast"
                checked={!!value.fast}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(fast) => onChange({ ...value, fast })}
              >
                <span>Fast</span>
                <small>⌘⇧E</small>
                <span className="ui-model-fast-switch" data-checked={!!value.fast}>
                  <i />
                </span>
              </DropdownMenuCheckboxItem>
            )}
          </div>
          {(onEdit || onVisibleChange) && (
            <div className="ui-model-footer">
              <DropdownMenuItem onSelect={editModels}>
                <Settings size={12} />
                Edit
              </DropdownMenuItem>
              <span>
                <Kbd>⌘⇧/</Kbd> Cycle effort
              </span>
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={manage} onOpenChange={setManage}>
        <DialogContent
          className="ui-model-manager"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogTitle>Add models</DialogTitle>
          <DialogDescription>Choose the models available in the model menu.</DialogDescription>
          <Input
            aria-label="Filter models"
            placeholder="Filter models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="ui-model-manager-list">
            {models
              .filter((model) =>
                `${model.name} ${model.provider}`.toLowerCase().includes(query.toLowerCase()),
              )
              .map((model) => (
                <label key={model.id} className="ui-model-manager-row">
                  <Checkbox
                    checked={
                      model.id === value.model || !visibleIds || visibleIds.includes(model.id)
                    }
                    disabled={model.id === value.model}
                    onCheckedChange={(checked) =>
                      onVisibleChange?.(
                        checked
                          ? [...new Set([...(visibleIds ?? models.map((m) => m.id)), model.id])]
                          : (visibleIds ?? models.map((m) => m.id)).filter((id) => id !== model.id),
                      )
                    }
                  />
                  <span>
                    {model.name}
                    <small>{model.provider}</small>
                  </span>
                </label>
              ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
