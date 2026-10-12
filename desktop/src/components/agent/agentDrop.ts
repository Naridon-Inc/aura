// A file or clip dropped on an agent pane becomes input at the agent's prompt.
//
// External OS drops (from Finder) are routed by osFileDrop.ts through Tauri's
// native channel; this is the in-app HTML5 drag — a file dragged out of the
// Files sidebar, or an image clip from the tray. It is engine-independent: the
// paths end up as bytes on the agent's PTY either way, so both the xterm canvas
// and the native one share it.

import { api } from "../../lib/api";

/** Whether a drag carries something we can turn into prompt input. Checked in
 *  `dragover` as well as `drop`, because a dragover that is never
 *  `preventDefault`'d makes the browser reject the drop outright — the drag
 *  just snaps back, which reads as "the file disappeared". */
export function acceptsAgentDrag(dt: DataTransfer | null): boolean {
  return (
    !!dt &&
    (dt.types.includes("text/uri-list") ||
      dt.types.includes("text/plain") ||
      dt.types.includes("Files") ||
      dt.types.includes("application/x-aura-clip"))
  );
}

/** Type the dropped thing at the agent's prompt. */
export function applyAgentDrop(sessionId: string, dt: DataTransfer | null): void {
  if (!dt) return;
  const auraClipRaw = dt.getData("application/x-aura-clip");
  if (auraClipRaw) {
    try {
      const meta = JSON.parse(auraClipRaw) as { id: string; kind: string };
      if (meta.kind === "image" && meta.id) {
        api
          .clipsCopyImageToOs(meta.id)
          .then(() => {
            // ^V — paste, so the agent reads the image off the OS clipboard
            // rather than being handed a path it would have to open.
            api.agentPtyWrite(sessionId, [0x16]).catch(() => {});
          })
          .catch(() => {
            const path = (JSON.parse(auraClipRaw) as { path: string }).path;
            const text = /\s/.test(path) ? `"${path}"` : path;
            writeText(sessionId, text + " ");
          });
        return;
      }
    } catch {
      /* malformed payload */
    }
  }

  const uri = dt.getData("text/uri-list");
  const plain = dt.getData("text/plain");
  const paths: string[] = [];
  if (uri && uri.length > 0) {
    for (const line of uri.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      paths.push(
        line.startsWith("file://")
          ? decodeURIComponent(line.slice("file://".length))
          : line,
      );
    }
  } else if (plain && plain.length > 0) {
    // The Files sidebar joins a multi-selection with newlines — split so each
    // becomes its own quoted argument rather than one bogus glob.
    for (const line of plain.split(/\r?\n/)) {
      const p = line.trim();
      if (p) paths.push(p);
    }
  } else if (dt.files && dt.files.length > 0) {
    for (const f of Array.from(dt.files) as unknown as { path?: string }[]) {
      if (f.path) paths.push(f.path);
    }
  }
  if (paths.length === 0) return;
  writeText(sessionId, paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ") + " ");
}

function writeText(sessionId: string, text: string): void {
  const bytes = Array.from(new TextEncoder().encode(text));
  api.agentPtyWrite(sessionId, bytes).catch(() => {});
}
