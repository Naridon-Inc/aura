import { type ReactNode } from "react";
import "./settings-mcp-parts.css";

/** A settings row title made of a name followed by badges. */
export function SettingsMcpTitle({ name, children }: { name: ReactNode; children?: ReactNode }) {
  return (
    <span className="ui-settings-mcp-title">
      <span>{name}</span>
      {children}
    </span>
  );
}

/** Buttons in a row's control slot that wrap, right-aligned, when the
 *  slot is narrower than they are. */
export function SettingsMcpToolbar({ children }: { children: ReactNode }) {
  return <div className="ui-settings-mcp-actions">{children}</div>;
}
