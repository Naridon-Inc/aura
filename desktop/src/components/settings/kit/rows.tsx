import * as React from "react";

import { cn } from "../../../lib/utils";
import { Field as UiField } from "../../ui/field";
import { Switch } from "../../ui/switch";

// ── The skeleton of a settings pane ───────────────────────────────────
//
// The measurements here aren't taste, they were read off a real settings
// pane pixel by pixel: hairline to hairline, a two-line row runs exactly
// 100px and a three-line row 122px. A 14px label on 19px of leading over a
// 13px description on 21px, separated by 4px, fills 44 of those — the other
// 56 is air, 28px above and below.
//
// Ours did the opposite: a 16px label over a 14px description with 10px of
// padding. Bigger type packed tighter, which reads as a dense list of
// shouting rather than a calm one you can scan down. The scale below is a
// step smaller and the space around it nearly triple. Because every pane is
// built from these three or four components, retuning them here re-rhythms
// all twenty-four at once.
//
// Flat and card-less throughout (the "no bulky cards" house rule): a row
// is a label, a description, a control and a hairline. A section is a
// quiet label over a divided list, never a bordered box.

/** A pane's heading. One prop, because the title is not the pane's to
 *  choose: it is `paneLabel(pane)` — the very string on the rail row you
 *  clicked to get here. Panes used to declare their own and seven of them
 *  disagreed with the rail, so one destination carried two names.
 *
 *  When the pane opens with a `PaneIntro`, the heading tightens against it
 *  so the two read as one title-and-subtitle block instead of two
 *  paragraphs that happen to be adjacent. */
export function PaneHeader({ title }: { title: string }) {
  return (
    <h1 className="mb-5 text-[30px] font-semibold leading-none tracking-tight text-text-1 [&:has(+p)]:mb-3">
      {title}
    </h1>
  );
}

/** The line under the heading: what this pane is for. The one thing the
 *  rail label can't carry.
 *
 *  Takes a node rather than a string because two panes need a path or a
 *  filename in the sentence, and `~/.aura/integrations.toml` set in the
 *  body face reads as prose you could mistake for a description of a
 *  concept rather than the name of a file on disk. */
export function PaneIntro({ text }: { text: React.ReactNode }) {
  return (
    <p className="mb-7 max-w-[520px] text-[13px] leading-relaxed text-text-3">
      {text}
    </p>
  );
}

/** A flat group of rows under a quiet label. `title` is optional — omit it
 *  for an unlabelled cluster (same as `Card`).
 *
 *  A section carries the hairline that ends the section before it, rather
 *  than floating clear of it on a margin. Sections used to be separated by
 *  space alone, which a group of one row turned into a hundred pixels of
 *  nothing between a setting and the next label — the pane looked like it
 *  had stopped. Ruled, the whole pane reads as one continuous list that
 *  happens to be labelled along the way, which is what it is. */
export function Section({
  title,
  icon,
  children,
}: {
  title?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  // `first-of-type` as well as `first`: most panes open with a `PaneIntro`,
  // and that <p> makes the leading section the second child — so `first`
  // alone left a rule hanging under the intro paragraph, above the very
  // first label. Both variants together mean "the first block of settings in
  // this pane", whichever way the pane happens to be written.
  return (
    <div className="border-t border-line-soft pt-8 first:border-t-0 first:pt-0 first-of-type:border-t-0 first-of-type:pt-0">
      {title && (
        <div className="mb-1 flex items-center gap-2">
          {icon && <span className="text-text-4 [&_svg]:size-3">{icon}</span>}
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-text-4">
            {title}
          </span>
        </div>
      )}
      <div className="divide-y divide-line-soft">{children}</div>
    </div>
  );
}

export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // No label, so nothing marks the seam — an unlabelled cluster just
        // goes on being the same list. It joins the row above on the same
        // hairline every other row uses.
        "divide-y divide-line-soft border-t border-line-soft first:border-t-0 first-of-type:border-t-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One setting row: label (+ optional description / dimmer hint) on the
 *  left, control right-aligned, both top-aligned so a three-line
 *  description never shoves the control down the page. */
export function Row({
  label,
  description,
  hint,
  children,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-7">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium leading-snug text-text-1">{label}</span>
        {description && (
          <span className="text-[13px] leading-relaxed text-text-3">{description}</span>
        )}
        {hint && <span className="text-xs leading-relaxed text-text-4">{hint}</span>}
      </div>
      <div className="shrink-0 pt-px">{children}</div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <UiField label={label} description={hint} className="py-4">
      {children}
    </UiField>
  );
}

export function Toggle({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row label={label} description={hint}>
      <Switch
        checked={value}
        onCheckedChange={onChange}
        disabled={disabled}
        className="shrink-0"
      />
    </Row>
  );
}
