import { SettingsFacts, SettingsStatusLine, type SettingsFact } from "../../ui/settings-blocks";

// The two blocks a title-and-control row can't carry: a set of facts about
// something, and whether we can reach it right now.

export type KeyValueRow = SettingsFact;

/** A read-only table of facts: which files, which device, when. */
export function KeyValueTable({ rows }: { rows: KeyValueRow[] }) {
  return <SettingsFacts rows={rows} />;
}

/** Whether something we depend on is reachable, and a way to ask again. */
export function ConnectionStatus({
  state,
  label,
  onRefresh,
  refreshing,
}: {
  state: "connected" | "disconnected" | "checking";
  /** Overrides the default wording when the page has something better to say. */
  label?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const text =
    label ?? (state === "connected" ? "Connected" : state === "checking" ? "Checking…" : "Not connected");
  return <SettingsStatusLine text={text} onRefresh={onRefresh} refreshing={refreshing} />;
}
