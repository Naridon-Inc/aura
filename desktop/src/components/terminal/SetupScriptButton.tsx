// The one button that drives a workspace's setup script: run it, run it
// again, or stop it. While the request is in flight it shows a spinner and
// what is happening instead of its label, and takes no clicks.

import { Play, RotateCw, Square } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";

export type SetupButtonMode = "run" | "rerun" | "stop";

export const SETUP_BUTTON_LABELS: Record<SetupButtonMode, { idle: string; pending: string }> = {
  run: { idle: "Run setup", pending: "Running..." },
  rerun: { idle: "Rerun setup", pending: "Running..." },
  stop: { idle: "Stop setup", pending: "Stopping..." },
};

const ICONS = { run: Play, rerun: RotateCw, stop: Square } as const;

export function SetupScriptButton({
  mode,
  pending = false,
  onClick,
  className,
  size = "sm",
}: {
  mode: SetupButtonMode;
  pending?: boolean;
  onClick: () => void;
  className?: string;
  size?: "xs" | "sm";
}) {
  const { idle, pending: busy } = SETUP_BUTTON_LABELS[mode];
  const Icon = ICONS[mode];
  return (
    <Button size={size} variant="outline" className={className} onClick={onClick} disabled={pending}>
      {pending ? <AsciiSpinner size={12} /> : <Icon className="h-3 w-3" />}
      {pending ? busy : idle}
    </Button>
  );
}
