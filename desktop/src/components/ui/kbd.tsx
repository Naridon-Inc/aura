// One key cap.
//
// Every theme pack in styles.css already declares `--color-kbd-bg` and
// `--color-kbd-fg` — five packs, each with its own considered pair — and
// until now nothing on screen read them. `vscodeTheme.ts` *writes* them when
// you import a VS Code theme, so the app has been carrying a themed key cap
// through the whole theming system without ever drawing one.
//
// It drew ten other things instead. This file used to be a two-line forward
// of `@medusajs/ui`'s Kbd, which paints from Medusa's own zinc tag ramp
// (`--tag-neutral-bg`), not ours; seven files imported it. Ten more sites
// hand-rolled a raw <kbd> with their own border, radius and type size, nine
// of them approximating exactly the bg-2 / line-soft / text-3 combination
// the theme tokens above already name. So: render the tokens, and the cap
// follows the theme pack the way everything else in the app does.
//
// Two callers legitimately don't use this and shouldn't:
//   • a cap sitting INSIDE a filled accent button (the plan card's Build key,
//     QuestionCard's ↵) has to invert against that fill, not the page
//   • the Slack-shell add-menu prints its accelerators as right-aligned plain
//     text, the macOS menu convention — a cap there would read as a button
// Both are documented at their call sites.

import * as React from "react";

import { cn } from "../../lib/utils";

export type KbdProps = React.ComponentPropsWithoutRef<"kbd">;

export const Kbd = React.forwardRef<HTMLElement, KbdProps>(
  ({ className, ...props }, ref) => (
    <kbd
      ref={ref}
      className={cn(
        "inline-flex h-5 w-fit min-w-[20px] items-center justify-center",
        "rounded border border-line-soft px-1",
        "bg-kbd-bg text-kbd-fg font-mono text-2xs leading-none",
        className,
      )}
      {...props}
    />
  ),
);
Kbd.displayName = "Kbd";
