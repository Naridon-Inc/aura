import { type ReactNode } from "react";
import { RefreshCw } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Table, TableBody, TableCell, TableRow } from "./table";
import "./settings-blocks.css";

/** The sentence under a settings page title: what the page is for. */
export function SettingsIntro({ children }: { children: ReactNode }) {
  return <p className="ui-settings-intro">{children}</p>;
}

/** A run of rows with no heading of its own. Spaced like a section so the
 *  page keeps one rhythm whether a block is titled or not. */
export function SettingsGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("ui-settings-group", className)}>{children}</div>;
}

export interface SettingsFact {
  key: string;
  label: string;
  value: ReactNode;
  /** Paths, ids and commands read better in the mono face. */
  mono?: boolean;
}

/** A read-only table of facts: label on the left, value right-aligned. */
export function SettingsFacts({ rows }: { rows: SettingsFact[] }) {
  return (
    <Table className="ui-settings-facts">
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell>{row.label}</TableCell>
            <TableCell className={row.mono ? "ui-settings-mono" : undefined}>{row.value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** One line of live status with a way to ask again. */
export function SettingsStatusLine({
  text,
  onRefresh,
  refreshing,
}: {
  text: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <div className="ui-provider-login-status">
      <span>{text}</span>
      {onRefresh && (
        <Button size="sm" variant="ghost" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw />
          Refresh
        </Button>
      )}
    </div>
  );
}

/** A failure the page could not recover from on its own. */
export function SettingsError({ children }: { children: ReactNode }) {
  return (
    <p className="ui-settings-error" role="alert">
      {children}
    </p>
  );
}

/** Buttons that sit side by side in a row's control slot. */
export function SettingsActions({ children }: { children: ReactNode }) {
  return <div className="ui-settings-actions">{children}</div>;
}

/** What a list says when it has nothing in it yet. */
export function SettingsEmpty({ children }: { children: ReactNode }) {
  return <p className="ui-settings-empty">{children}</p>;
}
