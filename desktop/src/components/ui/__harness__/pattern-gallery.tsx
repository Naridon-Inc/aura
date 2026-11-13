import { GitWorkflowToolbar, GIT_WORKFLOW_LABELS, type GitWorkflowState } from "../git-workflow";
import { useState } from "react";
import { ComposerPatternPreview } from "./composer-pattern-preview";
import { TranscriptPatternPreview } from "./transcript-pattern-preview";
import { WorkspacePatternPreview } from "./workspace-pattern-preview";
import { ArtifactPatternPreview } from "./artifact-pattern-preview";
import { SettingsPatternPreview } from "./settings-pattern-preview";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../tab-panels";
export function PatternGallery() {
  const [tab, setTab] = useState("Composer");
  return (
    <div className="lab-pattern-gallery">
      <header>
        <h1>Interaction patterns</h1>
        <p>Reusable interface patterns with local sample data.</p>
      </header>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="lab-pattern-tabs" aria-label="Pattern families">
          {["Composer", "Transcript", "Workspace", "Artifacts", "Settings", "Git workflows"].map(
            (name) => (
              <TabsTrigger key={name} value={name}>
                {name}
              </TabsTrigger>
            ),
          )}
        </TabsList>
        <TabsContent value="Composer">
          <ComposerPatternPreview />
        </TabsContent>
        <TabsContent value="Transcript">
          <TranscriptPatternPreview />
        </TabsContent>
        <TabsContent value="Workspace">
          <WorkspacePatternPreview />
        </TabsContent>
        <TabsContent value="Artifacts">
          <ArtifactPatternPreview />
        </TabsContent>
        <TabsContent value="Git workflows">
          <div className="lab-git-gallery">
            {Object.keys(GIT_WORKFLOW_LABELS).map((state) => (
              <div key={state}>
                <h3>{GIT_WORKFLOW_LABELS[state as GitWorkflowState]}</h3>
                <GitWorkflowToolbar
                  workflow={{
                    state: state as GitWorkflowState,
                    prNumber: state === "no-pr" ? undefined : 42,
                    branch: "workspace-command-menu",
                    targetBranch: "main",
                    changedFiles: 3,
                    ahead: 2,
                    behind: 1,
                    failedChecks: 1,
                    totalChecks: 4,
                  }}
                />
              </div>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="Settings">
          <SettingsPatternPreview />
        </TabsContent>
      </Tabs>
    </div>
  );
}
