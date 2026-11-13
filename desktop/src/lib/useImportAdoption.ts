// The window's half of Settings → Import. The importer can't touch the
// project list (it lives in this window's storage), so the page hands over
// what came in and this adds the repositories to the list and gives every
// folder the name and pin it had in the other app — without renaming
// anything the person already named here.

import { useEffect, type Dispatch, type SetStateAction } from "react";

import { api } from "./api";
import { IMPORT_PROJECTS_EVENT, type ImportAdopt } from "./importSources";
import { persistRecents, rememberRecent } from "./recentProjects";
import { getWorkspaceName, isWorkspacePinned, setWorkspaceName, setWorkspacePinned } from "./workspaceCustomization";

/** Names and pins first, so a repository joins the list already pinned and
 *  eviction never takes it. Returns the repositories to add. */
export function applyAdoptCustomization(adopt: readonly ImportAdopt[]): ImportAdopt[] {
  for (const a of adopt) {
    if (a.name && !getWorkspaceName(a.root)) setWorkspaceName(a.root, a.name);
    if (a.pinned && !isWorkspacePinned(a.root)) setWorkspacePinned(a.root, true);
  }
  return adopt.filter((a) => a.project);
}

export function useImportAdoption(setRecents: Dispatch<SetStateAction<string[]>>) {
  useEffect(() => {
    function onImported(e: Event) {
      const adopt = (e as CustomEvent<{ adopt?: ImportAdopt[] }>).detail?.adopt ?? [];
      const projects = applyAdoptCustomization(adopt);
      if (projects.length === 0) return;
      setRecents((prev) => {
        let next = prev;
        for (const a of projects) next = rememberRecent(next, a.root);
        if (next !== prev) persistRecents(next);
        return next;
      });
      for (const a of projects) {
        // The Manager loop resolves projects from ~/.aura/projects.json.
        api.projectsRegister(a.root, a.name ?? undefined).catch((err) => {
          console.warn("[import] could not register", a.root, err);
        });
      }
    }
    window.addEventListener(IMPORT_PROJECTS_EVENT, onImported);
    return () => window.removeEventListener(IMPORT_PROJECTS_EVENT, onImported);
  }, [setRecents]);
}
