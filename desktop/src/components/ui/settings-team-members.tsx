import { type ReactNode } from "react";
import "./cloud-patterns.css";
import "./settings-team-members.css";

// A list of people on a settings page: a label with an optional action
// beside it, then one row per person with their face, name, a quieter line
// under the name and the controls that act on them. The organization member
// list draws people this way, so every roster in settings reads the same.

export function SettingsMemberList({
  label,
  action,
  note,
  children,
}: {
  label: ReactNode;
  action?: ReactNode;
  /** One quiet sentence under the label: whose list this is. */
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ui-cloud-settings ui-settings-member-list">
      <header className="ui-cloud-row">
        <p>{label}</p>
        {action}
      </header>
      {note && <p>{note}</p>}
      {children}
    </div>
  );
}

export function SettingsMemberRow({
  avatar,
  name,
  detail,
  extra,
  control,
}: {
  avatar: ReactNode;
  name: ReactNode;
  detail?: ReactNode;
  /** Further quiet lines under the detail, such as other addresses. */
  extra?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="ui-cloud-member-row">
      <div className="ui-settings-member-face">{avatar}</div>
      <span>
        <strong>{name}</strong>
        {detail && <small>{detail}</small>}
        {extra}
      </span>
      {control}
    </div>
  );
}
