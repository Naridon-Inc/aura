import { type SettingsView } from "../../lib/api";
import { CloudEnvVarsPanel } from "../cloudplace/CloudEnvVarsPanel";
import { CloudRunnerPanel } from "../commons/crew/CloudRunnerPanel";
import { InstalledModesPane } from "../marketplace/InstalledModesPane";
import { MobileWaitlistTab } from "../mobile/MobileWaitlistTab";
import { ModelDefaultsPanel } from "../manager/ModelDefaultsPanel";
import { SettingsEmpty } from "../ui/settings-blocks";
import { SettingsAdvanced } from "../ui/settings-advanced";
import { AgentsTab } from "./AgentsTab";
import { BrainTab } from "./BrainTab";
import { CloudComputerPage } from "./CloudComputerPage";
import { ConnectedServicesTab } from "./connected/ConnectedServicesTab";
import { LocalModelsTab } from "./LocalModelsTab";
import { McpServersTab } from "./McpServersTab";
import { Fold } from "./Fold";
import {
  advancedOpens,
  repoPageOf,
  type FoldedPageId,
  type SettingsLink,
  type SettingsPage,
} from "./nav";
import { ApiKeysPage } from "./org/ApiKeysPage";
import { BillingPage } from "./org/BillingPage";
import { OrganizationPage } from "./org/OrganizationPage";
import { AdvancedPage } from "./pages/AdvancedPage";
import { AccountOverview } from "./pages/AccountOverview";
import { ChangeReasonsPage } from "./pages/ChangeReasonsPage";
import { AccountsProfiles } from "./pages/AccountsProfiles";
import { AppearancePage, AppearanceStyleRows } from "./pages/AppearancePage";
import { EditorThemesPage } from "./pages/EditorThemesPage";
import { ExperimentalPage } from "./pages/ExperimentalPage";
import { GeneralEditorRows, GeneralPage } from "./pages/GeneralPage";
import { HelpPage } from "./pages/HelpPage";
import { HudPage } from "./pages/HudPage";
import { ImportPage } from "./import/ImportPage";
import { IdentitySection } from "./pages/IdentityGit";
import { ModelsPage } from "./pages/ModelsPage";
import { RecordChangesPage } from "./pages/RecordChangesPage";
import { SecurityPolicyPage } from "./pages/SecurityPolicyPage";
import { ShortcutsPage } from "./pages/ShortcutsPage";
import { TerminalPage } from "./pages/TerminalPage";
import { UsageDataPage } from "./pages/UsageDataPage";
import { PlaceEnvPane } from "./PlaceEnvPane";
import { PluginsTab } from "./PluginsTab";
import { RepoWorktreeSettingsPane } from "./RepoWorktreeSettingsPane";
import { TeamTab } from "./TeamTab";
import { YourGithubSection } from "./YourGithubSection";
import { WorkspaceLandingRow } from "./WorkspaceLandingRow";

/** The body of one settings page: the page's own few rows, then one
 *  collapsed Advanced holding its rarer parts. The frame prints the title; a
 *  page never names itself. */
export function SettingsPageView({
  page,
  view,
  repoRoot,
  currentRepo,
  roots,
  query,
  foldAsked,
  reload,
  onClose,
  go,
}: {
  page: SettingsPage;
  /** The loaded settings, for the pages that edit them directly. */
  view: SettingsView | null;
  /** The repository a repository-scoped page acts on. */
  repoRoot: string;
  /** The repository the window has open. */
  currentRepo: string;
  /** Every open repository, current first. */
  roots: string[];
  query: string;
  /** The folded part a link just asked for, if any. */
  foldAsked: FoldedPageId | null;
  reload: () => Promise<void>;
  onClose: () => void;
  go: (link: SettingsLink) => void;
}) {
  const needsRepo = (what: string) => <SettingsEmpty>Open a repository to {what}.</SettingsEmpty>;
  const opens = advancedOpens(page, foldAsked, query);
  const repo = repoPageOf(page);
  if (repo) {
    return (
      <>
        <RepoWorktreeSettingsPane
          key={repo.root}
          repoRoot={repo.root}
          section={repo.section}
          landing={<WorkspaceLandingRow />}
        />
        {repo.section === "misc" && (
          <SettingsAdvanced openWhen={opens}>
            <Fold id="capture">
              <RecordChangesPage repoRoot={repo.root} />
            </Fold>
            <Fold id="aurawatch">
              <ChangeReasonsPage repoRoot={repo.root} />
            </Fold>
            {view && (
              <Fold id="policy">
                <SecurityPolicyPage view={view} repoRoot={repo.root} onChanged={reload} />
              </Fold>
            )}
          </SettingsAdvanced>
        )}
      </>
    );
  }
  switch (page) {
    case "general":
      return (
        <>
          <GeneralPage />
          <SettingsAdvanced openWhen={opens}>
            <Fold id="editor">
              <GeneralEditorRows />
            </Fold>
            <Fold id="hud">
              <HudPage />
            </Fold>
          </SettingsAdvanced>
        </>
      );
    case "account":
      return (
        <>
          <AccountOverview repoRoot={currentRepo} />
          <SettingsAdvanced openWhen={opens}>
            <Fold id="identity" bare>
              <IdentitySection repoRoots={roots} />
            </Fold>
            <Fold id="profiles" bare>
              <AccountsProfiles repoRoot={currentRepo} part="account" />
            </Fold>
            {view && (
              <Fold id="connected">
                <ConnectedServicesTab view={view} repoRoot={repoRoot} onChanged={reload} />
              </Fold>
            )}
            <Fold id="telemetry">
              <UsageDataPage />
            </Fold>
            <Fold id="mobile">
              <MobileWaitlistTab />
            </Fold>
          </SettingsAdvanced>
        </>
      );
    case "appearance":
      return (
        <>
          <AppearancePage />
          <SettingsAdvanced openWhen={opens}>
            <Fold id="look">
              <AppearanceStyleRows />
            </Fold>
            <Fold id="themes">
              <EditorThemesPage />
            </Fold>
          </SettingsAdvanced>
        </>
      );
    case "shortcuts":
      return <ShortcutsPage query={query} />;
    case "models":
      return (
        <>
          <ModelsPage onConfigureAgent={() => go("agents")} />
          <SettingsAdvanced openWhen={opens}>
            <Fold id="routing">
              <ModelDefaultsPanel defaultOpen />
            </Fold>
            <Fold id="brain">
              <BrainTab />
            </Fold>
            <Fold id="local-models">
              <LocalModelsTab />
            </Fold>
          </SettingsAdvanced>
        </>
      );
    case "git":
      return (
        <>
          <YourGithubSection />
          <AccountsProfiles repoRoot={currentRepo} part="git" />
        </>
      );
    case "agents":
      return (
        <AgentsTab advancedOpen={opens} repoRoot={currentRepo} onOpened={onClose}>
          <Fold id="modes">
            <InstalledModesPane />
          </Fold>
          <Fold id="plugins" bare>
            <PluginsTab />
          </Fold>
        </AgentsTab>
      );
    case "environment":
      return repoRoot ? <PlaceEnvPane repoRoot={repoRoot} /> : needsRepo("manage its secrets and tools");
    case "mcp":
      return <McpServersTab repoRoot={repoRoot} />;
    case "computer":
      return (
        <>
          <CloudComputerPage go={go} onClose={onClose} />
          <CloudEnvVarsPanel />
          <SettingsAdvanced openWhen={opens}>
            <Fold id="cloud">
              <CloudRunnerPanel repoRoot={repoRoot} />
            </Fold>
          </SettingsAdvanced>
        </>
      );
    case "import":
      return <ImportPage />;
    case "organization":
      return <OrganizationPage go={go} />;
    case "team":
      return repoRoot ? <TeamTab repoRoot={repoRoot} /> : needsRepo("see its team");
    case "billing":
      return <BillingPage onSignIn={() => go("account")} />;
    case "api":
      return <ApiKeysPage onSignIn={() => go("account")} />;
    case "experimental":
      return <ExperimentalPage />;
    case "advanced": {
      const help = (
        <SettingsAdvanced label="Help & about" openWhen={opens}>
          <div className="ui-settings-fold" data-fold="help">
            <HelpPage onClose={onClose} onShortcuts={() => go("shortcuts")} />
          </div>
        </SettingsAdvanced>
      );
      // Help reads nothing from the loaded settings. When they fail to load
      // the page's own rows have nothing to show, but Help, and the way to
      // report the failure, must still be there.
      return view ? (
        <AdvancedPage view={view} onChanged={reload}>
          {help}
        </AdvancedPage>
      ) : (
        help
      );
    }
    case "terminal":
      return <TerminalPage />;
  }
}
