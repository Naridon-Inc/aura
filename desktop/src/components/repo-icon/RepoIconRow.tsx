import { SettingsRow } from "../ui/settings-row";
import { humanizeWorkspaceName } from "../../lib/workspaceLabel";
import { useWorkspaceCustomization } from "../../lib/workspaceCustomization";
import { RepoIconPicker } from "./RepoIconPicker";

/** A repository's "Icon" setting: what it wears next to its name in the
 *  sidebar. Self-contained; it keeps every pick as it is made. */
export function RepoIconRow({ repoRoot }: { repoRoot: string }) {
  const custom = useWorkspaceCustomization();
  const name = custom[repoRoot]?.name || humanizeWorkspaceName(repoRoot);
  return (
    <SettingsRow
      title="Icon"
      description="Shown next to the repository name in the sidebar."
      control={<RepoIconPicker repoRoot={repoRoot} name={name} />}
    />
  );
}
