// The rows a conversation composer adds to the shared add menu, below the
// shared ones: how the next turn should behave. Every row is the shared
// menu's row — an icon, the label taking the room, and a muted end — so the
// ends line up down the menu. Mode and approvals open as submenus with the
// current choice at the end; Goal and Concise are settings with a switch at
// the end that shows on and off alike. Plan stays the shared menu's own row
// (and ⇧Tab), so the Mode submenu carries the other three.

import { AlignLeft, Check, ShieldCheck, SlidersHorizontal, Target } from "lucide-react";
import type { ApprovalPolicy } from "../../../lib/api";
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuSwitchItem,
} from "../../ui/dropdown-menu";
import type { ComposerMode } from "../../manager/chat/composerTypes";

/** The ＋ menu's rows end in a text "›", not the chevron other menus use. */
const SUBMENU_MARK = (
  <span aria-hidden="true" className="ui-menu-sub-mark">
    ›
  </span>
);

export const TURN_MODES: { value: ComposerMode; label: string; hint: string }[] = [
  { value: "build", label: "Agent", hint: "Edit files and run tools" },
  { value: "plan", label: "Plan", hint: "Plan changes before building" },
  { value: "ask", label: "Ask", hint: "Explore without changing files" },
  { value: "auto", label: "Auto", hint: "Let Aura choose the mode" },
];

// `null` is the agent's own ask-first flow: no permission flag is sent, so
// the invocation stays byte-identical to an agent run without Aura.
export const APPROVAL_OPTIONS: { value: ApprovalPolicy | null; label: string; hint: string }[] = [
  { value: null, label: "Default", hint: "Asks before risky edits" },
  { value: "accept_edits", label: "Accept edits", hint: "Edits land without asking; shell commands still ask" },
  { value: "plan", label: "Read only", hint: "Proposes a plan and changes nothing on disk" },
  { value: "bypass", label: "Bypass", hint: "Skips every permission prompt" },
];

export function ComposerTurnMenu({
  mode,
  modes,
  onModeChange,
  modeDisabled,
  approval,
  goal,
  concise,
}: {
  mode: ComposerMode;
  /** The modes this conversation can run; every one when absent. */
  modes?: ComposerMode[];
  onModeChange: (mode: ComposerMode) => void;
  modeDisabled?: boolean;
  approval?: { value: ApprovalPolicy | null; onChange: (value: ApprovalPolicy | null) => void };
  /** Absent when this conversation can't send a goal. */
  goal?: { value: boolean; onChange: (value: boolean) => void; disabled?: boolean };
  concise?: { value: boolean; onChange: (value: boolean) => void };
}) {
  const modeLabel = TURN_MODES.find((m) => m.value === mode)?.label ?? "Agent";
  const approvalLabel = approval
    ? (APPROVAL_OPTIONS.find((o) => o.value === approval.value) ?? APPROVAL_OPTIONS[0]).label
    : null;
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={modeDisabled} indicator={SUBMENU_MARK}>
          <SlidersHorizontal />
          <span className="ui-menu-text">Mode</span>
          <DropdownMenuShortcut>{modeLabel}</DropdownMenuShortcut>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent sideOffset={6} className="ui-composer-add-sub">
          {TURN_MODES.filter((m) => !modes || modes.includes(m.value)).map((m) => (
            <DropdownMenuItem key={m.value} title={m.hint} onSelect={() => onModeChange(m.value)}>
              <span className="ui-menu-text">{m.label}</span>
              {m.value === mode && <Check size={14} />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {approval && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger indicator={SUBMENU_MARK}>
            <ShieldCheck />
            <span className="ui-menu-text">Approvals</span>
            <DropdownMenuShortcut>{approvalLabel}</DropdownMenuShortcut>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent sideOffset={6} className="ui-composer-add-sub">
            {APPROVAL_OPTIONS.map((o) => (
              <DropdownMenuItem
                key={o.value ?? "default"}
                title={o.hint}
                onSelect={() => approval.onChange(o.value)}
              >
                <span className="ui-menu-text">{o.label}</span>
                {o.value === approval.value && <Check size={14} />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      {goal && (
        <DropdownMenuSwitchItem
          checked={goal.value}
          disabled={goal.disabled}
          title="The next message is planned through the crew loop and proved"
          onCheckedChange={(v) => goal.onChange(v === true)}
        >
          <Target />
          <span className="ui-menu-text">Send as goal</span>
        </DropdownMenuSwitchItem>
      )}
      {concise && (
        <DropdownMenuSwitchItem
          checked={concise.value}
          title="Claude Code keeps replies short; other engines ignore this"
          onCheckedChange={(v) => concise.onChange(v === true)}
        >
          <AlignLeft />
          <span className="ui-menu-text">Concise answers</span>
        </DropdownMenuSwitchItem>
      )}
    </>
  );
}
