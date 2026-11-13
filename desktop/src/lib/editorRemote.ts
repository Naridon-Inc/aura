// Opening a workspace's folder on one of the org's machines in VS Code or
// Cursor, through their own Remote-SSH. The desktop only offers an editor
// that is installed here and whose ssh reaches the machine without the key
// only Aura holds (see `cmd_editor_remote.rs`).

import { invoke } from "@tauri-apps/api/core";

/** What each editor is called where it is offered. */
export const REMOTE_EDITOR_NAMES: Record<string, string> = { vscode: "VS Code", cursor: "Cursor" };

/** The editors that can open this machine's folders from here; empty hides
 *  the choice. */
export const machineRemoteEditors = (machineId: string) =>
  invoke<string[]>("machine_remote_editors", { machineId });

/** Open `folder` on the machine in a Remote-SSH window of `editorId`. */
export const machineOpenInEditor = (machineId: string, editorId: string, folder: string) =>
  invoke<void>("machine_open_in_editor", { machineId, editorId, folder });
