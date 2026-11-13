// The rows both add-project dialogs draw the same way: a folder field with
// Browse beside it, the "working on it" line, the red box a failure lands in,
// and the primary button that carries its ⌘↵.

import { CornerDownLeft } from "lucide-react";
import { AsciiSpinner } from "../../../ui/ascii-spinner";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { Label } from "../../../ui/label";
import { browseForDir } from "./projectLocation";

export function LocationField({
  label,
  value,
  onChange,
  browseTitle,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (dir: string) => void;
  /** The prompt the native folder picker shows. */
  browseTitle: string;
  disabled?: boolean;
}) {
  const browse = () => {
    browseForDir(browseTitle, value)
      .then((dir) => {
        if (dir) onChange(dir);
      })
      .catch((e) => console.error("[add project] folder picker failed:", e));
  };
  return (
    <div className="ui-add-project-field">
      <Label>{label}</Label>
      <div className="ui-add-project-location">
        <Input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter path or click to select"
          disabled={disabled}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <Button variant="outline" onClick={browse} disabled={disabled}>
          Browse
        </Button>
      </div>
    </div>
  );
}

/** "Cloning..." / "Creating..." with the spinner, while the backend works. */
export function WorkingLine({ text }: { text: string }) {
  return (
    <div className="ui-add-project-working" role="status">
      <AsciiSpinner size={14} />
      <p>{text}</p>
    </div>
  );
}

export function FailureBox({ message }: { message: string }) {
  return (
    <div className="ui-add-project-error" role="alert">
      <p>{message}</p>
    </div>
  );
}

/** The dialog's one action, right-aligned, with ⌘↵ shown beside its label. */
export function PrimaryAction({
  label,
  busyLabel,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  busyLabel: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="ui-add-project-actions">
      <Button onClick={onClick} disabled={disabled} data-primary-action>
        {busy ? (
          busyLabel
        ) : (
          <>
            {label}
            <span aria-hidden="true" className="ui-add-project-chord">
              ⌘<CornerDownLeft size={12} />
            </span>
          </>
        )}
      </Button>
    </div>
  );
}
