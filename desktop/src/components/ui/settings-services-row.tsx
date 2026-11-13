import { type CSSProperties, type ReactNode } from "react";

import "./settings-services-row.css";

/** A row title for something you connect to: its mark, its name and, when
 *  there is one, a badge saying how it is being used. */
export function SettingsServiceTitle({
  mark,
  badge,
  children,
}: {
  mark?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="ui-settings-service-title">
      {mark}
      <span>{children}</span>
      {badge}
    </span>
  );
}

/** The 16px square a service's mark is drawn in. An empty one carries the
 *  service's initial, so a service with no mark still lines up. */
export function SettingsServiceMark({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span className="ui-settings-service-mark" style={style} aria-hidden>
      {children}
    </span>
  );
}

/** A short run of lines under a row, such as the problems one import hit. */
export function SettingsServiceList({ items, more }: { items: string[]; more?: string }) {
  return (
    <ul className="ui-settings-service-list">
      {items.map((item, i) => (
        <li key={i} title={item}>
          {item}
        </li>
      ))}
      {more && <li>{more}</li>}
    </ul>
  );
}
