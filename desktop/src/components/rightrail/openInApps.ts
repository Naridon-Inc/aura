// "Open in" on a changed file: the editors on this computer, each opening
// the file where it sits on disk.

import { api, type EditorInfo } from "../../lib/api";
import { toast } from "../../lib/toast";
import type { FileApplication } from "../ui/file-actions-menu";

type Open = (path: string, editorId: string) => Promise<void>;

/** Every available editor, in the order the list came back. */
export function openInApps(editors: EditorInfo[], path: string, open: Open = api.editorOpen): FileApplication[] {
  return editors
    .filter((app) => app.available)
    .map((app) => ({
      id: app.id,
      label: app.name,
      onOpen: () => void open(path, app.id).catch((e) => toast.danger(`Couldn't open in ${app.name}`, String(e))),
    }));
}
