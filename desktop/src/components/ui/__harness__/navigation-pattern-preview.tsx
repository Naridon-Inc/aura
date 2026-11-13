import { useState } from "react";
import { NavigationGroups, type NavigationSection } from "../navigation-groups";
const initialSections: NavigationSection[] = [
  {
    id: "pinned",
    title: "Pinned",
    kind: "pinned",
    workspaces: [
      {
        id: "main",
        label: "Workspace command menu",
        status: "review",
        unread: true,
        added: 128,
        removed: 24,
      },
    ],
  },
  {
    id: "shared",
    title: "Shared with me",
    kind: "shared",
    workspaces: [{ id: "shared-review", label: "Review navigation", status: "working" }],
  },
  {
    id: "custom",
    title: "This week",
    kind: "custom",
    workspaces: [{ id: "draft", label: "New workspace", draft: true }],
  },
  {
    id: "repository",
    title: "interface-system",
    kind: "repository",
    workspaces: [{ id: "completed", label: "Fix sidebar scrolling", status: "done" }],
  },
];
export function NavigationPatternPreview() {
  const [sections, setSections] = useState(initialSections),
    [selected, setSelected] = useState("main");
  return (
    <section className="lab-sidebar-specimen">
      <NavigationGroups
        sections={sections}
        onChange={setSections}
        selected={selected}
        onSelect={setSelected}
        onCreate={(id) => {
          const workspace = { id: crypto.randomUUID(), label: "New workspace", draft: true };
          setSections(
            sections.map((section) =>
              section.id === id
                ? { ...section, workspaces: [...section.workspaces, workspace] }
                : section,
            ),
          );
          setSelected(workspace.id);
        }}
        onArchive={(id) =>
          setSections(
            sections.map((section) => ({
              ...section,
              workspaces: section.workspaces.filter((workspace) => workspace.id !== id),
            })),
          )
        }
      />
      <p className="lab-pattern-help">
        Drag groups or workspaces to reorder. Use Alt + ↑ / ↓ on a focused row. Row menus move
        workspaces between groups.
      </p>
    </section>
  );
}
