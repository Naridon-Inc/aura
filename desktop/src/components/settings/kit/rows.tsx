import * as React from "react";

import { Field as UiField } from "../../ui/field";
import { SettingsGroup, SettingsIntro } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { Switch } from "../../ui/switch";

// The skeleton of a settings page, drawn with the shared settings rows.
// The page title itself is printed by the settings frame from the page
// list, so a page never names itself and can never disagree with the
// entry you clicked to reach it.

/** The line under the page title: what this page is for. Takes a node
 *  because a few pages need a path or filename inside the sentence. */
export function PaneIntro({ text }: { text: React.ReactNode }) {
  return <SettingsIntro>{text}</SettingsIntro>;
}

/** A titled group of rows. Without a title it is an untitled run of rows
 *  spaced like a section, so a page keeps one rhythm either way. */
export function Section({
  title,
  description,
  children,
}: {
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (!title) return <SettingsGroup>{children}</SettingsGroup>;
  return (
    <SettingsSection title={title} description={description}>
      {children}
    </SettingsSection>
  );
}

/** An untitled cluster of rows. */
export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <SettingsGroup className={className}>{children}</SettingsGroup>;
}

/** One setting: title and description on the left, the control right. */
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
  return <SettingsRow title={label} description={description} help={hint} control={children} />;
}

/** A labelled input stacked over its help text, for forms inside a page. */
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
    <UiField label={label} description={hint} className="ui-settings-field">
      {children}
    </UiField>
  );
}

/** A switch row. */
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
    <SettingsRow
      title={label}
      description={hint}
      control={
        <Switch aria-label={label} checked={value} onCheckedChange={onChange} disabled={disabled} />
      }
    />
  );
}
