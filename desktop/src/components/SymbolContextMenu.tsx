// Right-click affordance for any rendered AST symbol — function name,
// class, breadcrumb, touched-symbols list row. Surfaces the three Aura
// surgical actions a developer reaches for once they spot a regression
// inside a single symbol:
//
//   • Rewind this function — opens the Time machine with identifier + file
//     already populated. Because both are known, it pre-selects the moment
//     that touched the file and points the user straight at this symbol's
//     "Bring this back" (revert just this symbol to its last safe version).
//   • Show snapshot diff   — drops the user into the History sidebar so
//     they can pick which snapshot to compare against.
//   • Log intent for this change — pre-fills LogIntentDialog with a
//     starter sentence mentioning the symbol so the user just edits the
//     "why" instead of typing the boilerplate.
//
// All three actions ride existing `aura:open-*` window events — same
// idiom Composer / SessionInfoCard already use. No prop drilling. The
// rewind event detail shape (`{ identifier, file }`) is the contract
// App reads to open the Time machine tool with these as default props.

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";

type Props = {
  /** AST symbol name, e.g. "calculate_tax". */
  identifier: string;
  /** Absolute path to the file the symbol lives in. RewindDialog will
   *  normalise to repo-relative on open. */
  filePath: string;
  /** Symbol kind for the menu label badge. */
  kind?: "fn" | "class" | "type" | string;
  children: React.ReactNode;
};

export function SymbolContextMenu({ identifier, filePath, kind, children }: Props) {
  const kindLabel = (kind ?? "symbol").toUpperCase();

  function dispatch(name: string, detail: unknown) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[260px]">
        <ContextMenuLabel className="flex items-center gap-1.5">
          <span className="text-text-5">{kindLabel}</span>
          <span className="text-text-1 font-mono normal-case tracking-normal">
            {identifier}
          </span>
        </ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            dispatch("aura:open-rewind", { identifier, file: filePath })
          }
        >
          <span className="flex flex-col gap-0.5">
            <span>Bring this {kindWord(kind)} back</span>
            <span className="text-text-4 text-2xs normal-case tracking-normal">
              restore just {identifier} to its last safe version
            </span>
          </span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => dispatch("aura:open-history", null)}>
          Compare earlier versions
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            dispatch("aura:open-log-intent", {
              defaultText: `Refactored ${identifier} to `,
            })
          }
        >
          Add a reason for this change
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Human word for the rewind label — "function" / "class" reads better
// than the terse "fn" badge in a full sentence.
function kindWord(kind?: string): string {
  switch (kind) {
    case "fn":
      return "function";
    case "class":
      return "class";
    case "type":
      return "type";
    default:
      return "piece";
  }
}
