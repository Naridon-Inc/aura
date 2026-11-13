// Run with: bun test src/components/ui/cloud-home-empty.test.tsx
//
// With only the filters Home starts with, an empty list means nothing is
// open: it offers a new workspace (and the archived ones) instead of a
// "Clear filters" for filters nobody set.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CloudHome } from "./cloud-home";
import type { WorkspaceOverview } from "./workspace-preview-card";

const base = {
  members: [],
  ownerByWorkspace: {},
  pinnedIds: [],
  selectedOwners: [],
  onOwnersChange: () => {},
  onOpen: () => {},
  onProfile: () => {},
};

const archived = {
  id: "w1",
  title: "Old work",
  branch: "main",
  project: "site",
  projectId: "p1",
  stage: "done",
  updatedAt: 0,
  timeLabel: "2d ago",
  archived: true,
  workflow: "direct",
} as unknown as WorkspaceOverview;

describe("an empty Home", () => {
  test("with no workspaces at all offers a new one", () => {
    const html = renderToStaticMarkup(
      <CloudHome {...base} workspaces={[]} onCreate={() => {}} />,
    );
    expect(html).toContain("No workspaces yet");
    expect(html).toMatch(/<button[^>]*>New workspace<\/button>/);
    expect(html).not.toContain("Clear filters");
  });

  test("on a page that can't start one just says so", () => {
    const html = renderToStaticMarkup(<CloudHome {...base} workspaces={[]} />);
    expect(html).toContain("No workspaces yet");
    expect(html).not.toMatch(/>New workspace</);
  });

  test("with only archived work says nothing is open and offers both ways on", () => {
    const html = renderToStaticMarkup(
      <CloudHome {...base} workspaces={[archived]} onCreate={() => {}} />,
    );
    expect(html).toContain("No open workspaces");
    expect(html).toMatch(/<button[^>]*>New workspace<\/button>/);
    expect(html).toMatch(/<button[^>]*>Show archived<\/button>/);
    expect(html).not.toContain("Clear filters");
  });

  test("hidden by a filter the member chose still offers Clear filters", () => {
    const html = renderToStaticMarkup(
      <CloudHome {...base} workspaces={[archived]} selectedOwners={["someone"]} onCreate={() => {}} />,
    );
    expect(html).toContain("No matching workspaces");
    expect(html).toContain("Clear filters");
    expect(html).not.toContain("No open workspaces");
  });
});
