// Run with: bun test src/components/ui/workspace-dashboard.test.tsx
//
// The desktop app's web view never delivers an HTML5 `drop`, so a workspace
// card that was natively `draggable` lifted off its stage and never landed.
// The dashboard now moves cards with a pointer drag. These pin the markup that
// drag depends on: no card is natively draggable, and every stage is a target.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceDashboard } from "./workspace-dashboard";
import { WORKSPACE_STAGES, type WorkspaceOverview } from "./workspace-preview-card";

const scopes = (html: string) => [...html.matchAll(/data-pointer-drop-scope="([^"]+)"/g)].map((m) => m[1]);
const targets = (html: string) => [...html.matchAll(/data-pointer-drop="([^"]+)"/g)].map((m) => m[1]);

describe("the workspace dashboard", () => {
  const workspace: WorkspaceOverview = {
    id: "w1",
    title: "Importer",
    branch: "importer",
    project: "aura",
    projectId: "p1",
    stage: "backlog",
    updatedAt: 0,
    timeLabel: "now",
    workflow: { state: "no-pr" },
  };
  const html = renderToStaticMarkup(
    <WorkspaceDashboard
      workspaces={[workspace]}
      onOpen={() => {}}
      onMove={() => {}}
      onAction={() => {}}
      onCreate={() => {}}
    />,
  );

  test("cards are not natively draggable", () => {
    expect(html).toContain('aria-label="Importer"');
    expect(html).not.toMatch(/\sdraggable=/);
  });

  test("every stage is a target named by its id, in one drag scope", () => {
    expect(new Set(scopes(html)).size).toBe(1);
    expect(targets(html)).toEqual(WORKSPACE_STAGES.map((stage) => stage.id));
  });

  test("the repository tabs only show with more than one repository to pick", () => {
    expect(html).not.toContain('aria-label="Repository filter"');
    const two = renderToStaticMarkup(
      <WorkspaceDashboard
        workspaces={[workspace, { ...workspace, id: "w2", project: "site", projectId: "p2" }]}
        onOpen={() => {}}
        onMove={() => {}}
        onAction={() => {}}
        onCreate={() => {}}
        repositoryIcon={(id) => <i data-repo-picture={id} />}
      />,
    );
    expect(two).toContain('aria-label="Repository filter"');
    expect([...two.matchAll(/data-repo-picture="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "p1",
      "p2",
    ]);
  });
});
