import { MessageSquare, SquareTerminal } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

/** Chat or CLI: two views of the same session. It sits in the composer
 *  footer, which shows in both views (over the terminal it is the strip you
 *  type into), so the switch is reachable from either side. */
export function ChatViewSwitcher({
  value,
  onChange,
  disabled = false,
  disabledTitle,
}: {
  value: "terminal" | "chat";
  onChange: (view: "terminal" | "chat") => void;
  disabled?: boolean;
  /** Why the switch is off, shown on both choices while it is. */
  disabledTitle?: string;
}) {
  const why = disabled ? disabledTitle : undefined;
  return (
    <ToggleGroup
      type="single"
      size="sm"
      className="chat-view-switch"
      aria-label="Session view"
      value={value}
      disabled={disabled}
      // A single toggle group reports "" when its pressed item is pressed
      // again. There is always a view, so that is not a change.
      onValueChange={(next) => {
        if (next === "terminal" || next === "chat") onChange(next);
      }}
    >
      <ToggleGroupItem
        value="terminal"
        title={why ?? "Use this session’s native CLI"}
      >
        <SquareTerminal />
        CLI
      </ToggleGroupItem>
      <ToggleGroupItem
        value="chat"
        title={why ?? "Read and reply to this session in Chat"}
      >
        <MessageSquare />
        Chat
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
