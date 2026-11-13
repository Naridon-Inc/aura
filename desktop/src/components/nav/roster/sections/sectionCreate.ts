// "Create workspace" from a section's menu: the same Create dialog as
// everywhere else, and the workspace it makes is filed into that section.
// The section rides on the open request; any later request that names no
// section (⌘N, the palette, a repository's +) forgets it, so a workspace
// made some other way never lands in a section by surprise.

import { useEffect } from "react";
import {
  CREATE_WORKSPACE_EVENT,
  type CreateWorkspaceRequest,
} from "../../../workspace/createWorkspaceEvents";
import { putInSection } from "./sectionStore";

type SectionCreateRequest = CreateWorkspaceRequest & { sectionId?: string };

/** A request left this long without a workspace made is dropped. */
const FORGET_AFTER_MS = 15 * 60 * 1000;

let pending: { sectionId: string; at: number } | null = null;

export function createWorkspaceInSection(sectionId: string): void {
  const detail: SectionCreateRequest = { sectionId };
  window.dispatchEvent(new CustomEvent(CREATE_WORKSPACE_EVENT, { detail }));
}

/** Mounted once, by the list: files the next workspace made from a
 *  section's request into that section. */
export function useSectionCreateFiling(): void {
  useEffect(() => {
    const onRequest = (e: Event) => {
      const id = (e as CustomEvent<SectionCreateRequest | undefined>).detail?.sectionId;
      pending = id ? { sectionId: id, at: Date.now() } : null;
    };
    const onLaunched = (e: Event) => {
      const detail = (e as CustomEvent<{ repoRoot?: string; worktreePath?: string }>).detail;
      const ask = pending;
      pending = null;
      if (!ask || Date.now() - ask.at > FORGET_AFTER_MS) return;
      // Work started on the repository's own checkout is the repository, not
      // a workspace a section can hold.
      const path = detail?.worktreePath;
      if (!path || path === detail?.repoRoot) return;
      putInSection(path, ask.sectionId);
    };
    window.addEventListener(CREATE_WORKSPACE_EVENT, onRequest);
    window.addEventListener("aura:workspace-launched", onLaunched);
    return () => {
      window.removeEventListener(CREATE_WORKSPACE_EVENT, onRequest);
      window.removeEventListener("aura:workspace-launched", onLaunched);
    };
  }, []);
}
