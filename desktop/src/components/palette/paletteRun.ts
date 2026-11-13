// Carries out a fixed palette row. A row that names an app action goes to
// the host like any other pick; one that changes the palette itself (a scope
// typed into the field, the archived workspaces) leaves it open; everything
// else closes the palette and does its one thing.

import { emit } from "@tauri-apps/api/event";

import { api } from "../../lib/api";
import { setCloudCreating, setCloudPage } from "../../lib/cloudPlace";
import type { AppActionId } from "../../lib/keymap";
import { openExternal } from "../../lib/openExternal";
import { setThemePreference } from "../../lib/themeStore";
import { toast } from "../../lib/toast";
import { setWorkspaceArchived } from "../../lib/workspaceCustomization";
import type { CatalogItem } from "./paletteCatalog";

export type CatalogRunContext = {
  /** The folder in front, for Open in and Archive. */
  repoRoot?: string;
  theme: "dark" | "light";
  action: (id: AppActionId, label: string) => void;
  setQuery: (text: string) => void;
  showArchived: () => void;
  close: () => void;
};

/** Says what a palette row did; Toggle zen mode is answered by the app. */
export const TOGGLE_ZEN_EVENT = "aura:toggle-zen";

export function runCatalogItem(item: CatalogItem, ctx: CatalogRunContext): void {
  const run = item.run;
  switch (run.kind) {
    case "action":
      ctx.action(run.id, item.label);
      return;
    case "query":
      ctx.setQuery(run.text);
      return;
    case "archived":
      ctx.showArchived();
      return;
  }
  ctx.close();
  switch (run.kind) {
    case "event":
      window.dispatchEvent(new CustomEvent(run.name, { detail: run.detail }));
      return;
    case "url":
      void openExternal(run.url);
      return;
    case "theme":
      setThemePreference(ctx.theme === "dark" ? "light" : "dark");
      return;
    case "updates":
      emit("menu:check_for_updates").catch(() => toast.danger("Couldn't check for updates"));
      return;
    case "zen":
      window.dispatchEvent(new CustomEvent(TOGGLE_ZEN_EVENT));
      return;
    case "cloud-page":
      setCloudPage(run.page);
      return;
    case "cloud-create":
      setCloudCreating(true);
      return;
    case "open-in":
      if (ctx.repoRoot)
        api.editorOpen(ctx.repoRoot, run.app).catch((e) => toast.danger(`Couldn't open in ${run.name}`, String(e)));
      return;
    case "archive-workspace":
      if (ctx.repoRoot) setWorkspaceArchived(ctx.repoRoot, true);
      return;
  }
}
