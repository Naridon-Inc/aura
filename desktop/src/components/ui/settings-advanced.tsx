import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import "./settings-advanced.css";
export interface SettingsAdvancedProps {
  /** Trigger text. */
  label?: string;
  defaultOpen?: boolean;
  /** Opens the disclosure whenever it turns true, e.g. a deep link or an alert inside. */
  openWhen?: boolean;
  children: ReactNode;
}
/** The collapsed block at the foot of a settings page that holds its rarer rows. */
export function SettingsAdvanced({
  label = "Advanced",
  defaultOpen = false,
  openWhen = false,
  children,
}: SettingsAdvancedProps) {
  const [open, setOpen] = useState(defaultOpen || openWhen);
  const id = useId();
  useEffect(() => {
    if (openWhen) setOpen(true);
  }, [openWhen]);
  return (
    <div className="ui-settings-advanced" data-state={open ? "open" : "closed"}>
      <button
        type="button"
        className="ui-settings-advanced-trigger"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={16} aria-hidden />
        {label}
      </button>
      {open && (
        <div className="ui-settings-advanced-content" id={id}>
          {children}
        </div>
      )}
    </div>
  );
}
