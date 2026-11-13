// What the two add-project dialogs share: where a new project goes, what the
// folder is called, and how the finished project opens.
//
// The folder a project last landed in is remembered, so the second clone goes
// beside the first without anyone browsing for it again. Before that, it is
// ~/AuraProjects — the same default the first-run create page uses.

const DIR_KEY = "aura.roster.projectDir";
const DEFAULT_DIR = "AuraProjects";

/** The folder name a project name becomes: lower case, letters, digits and
 *  dashes, no leading or trailing dash. Empty when nothing usable is left. */
export function projectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/** The folder offered when a dialog opens. */
export async function defaultProjectDir(): Promise<string> {
  try {
    const saved = localStorage.getItem(DIR_KEY);
    if (saved && saved.trim()) return saved;
  } catch {
    // No storage: fall through to the home default.
  }
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    const home = (await homeDir()).replace(/\/+$/, "");
    return `${home}/${DEFAULT_DIR}`;
  } catch {
    return "";
  }
}

/** Keep the folder a project was just made in for next time. */
export function rememberProjectDir(dir: string): void {
  try {
    localStorage.setItem(DIR_KEY, dir.trim());
  } catch {
    // Not worth failing the create over.
  }
}

/** The native folder picker, starting where the field already points. */
export async function browseForDir(title: string, from: string): Promise<string | null> {
  const { pickPath } = await import("../../../../lib/nativeDialog");
  const picked = await pickPath({
    directory: true,
    multiple: false,
    title,
    defaultPath: from.trim() || undefined,
  });
  return typeof picked === "string" && picked ? picked : null;
}

/** Open a project that now exists on disk, the way every other door does. */
export function openCreatedProject(root: string): void {
  window.dispatchEvent(new CustomEvent("aura:open-repo-picker-path", { detail: { path: root } }));
}

/** ⌘↵ / Ctrl↵ — the dialogs' primary action from inside a field. */
export function isPrimaryChord(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}
