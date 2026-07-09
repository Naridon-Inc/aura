// Material Icon Theme bridge — resolves a file or folder name to a
// branded SVG path served from /public/file-icons. Manifest is generated
// at build time by `scripts/generate-file-icons.mjs`; we lazy-fetch it
// once on first call so the file-tree can render without a synchronous
// import bundling 4k+ folder names into the main JS chunk.
//
// Pattern lifted from superset-sh/superset:
// apps/desktop/src/renderer/screens/main/components/WorkspaceView/
//   RightSidebar/FilesView/utils/file-icons.ts

type IconManifest = {
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  defaultIcon: string;
  defaultFolderIcon: string;
  defaultFolderOpenIcon: string;
};

const ICON_BASE = "/file-icons";

let manifestPromise: Promise<IconManifest> | null = null;
let manifestCache: IconManifest | null = null;

export function loadIconManifest(): Promise<IconManifest> {
  if (manifestCache) return Promise.resolve(manifestCache);
  if (!manifestPromise) {
    manifestPromise = fetch(`${ICON_BASE}/manifest.json`)
      .then((r) => r.json() as Promise<IconManifest>)
      .then((m) => {
        manifestCache = m;
        return m;
      });
  }
  return manifestPromise;
}

export function iconUrl(iconName: string): string {
  return `${ICON_BASE}/${iconName}.svg`;
}

export function resolveIconName(
  manifest: IconManifest,
  fileName: string,
  isDirectory: boolean,
  isOpen: boolean,
): string {
  if (isDirectory) {
    const base = fileName.toLowerCase();
    if (isOpen && manifest.folderNamesExpanded[base]) {
      return manifest.folderNamesExpanded[base];
    }
    if (manifest.folderNames[base]) {
      return isOpen
        ? (manifest.folderNamesExpanded[base] ?? manifest.folderNames[base])
        : manifest.folderNames[base];
    }
    return isOpen ? manifest.defaultFolderOpenIcon : manifest.defaultFolderIcon;
  }

  if (manifest.fileNames[fileName]) return manifest.fileNames[fileName];
  const lower = fileName.toLowerCase();
  if (manifest.fileNames[lower]) return manifest.fileNames[lower];

  // Walk compound extensions: foo.d.ts → "d.ts" before "ts".
  const dot = fileName.indexOf(".");
  if (dot !== -1) {
    const after = fileName.slice(dot + 1).toLowerCase();
    const segs = after.split(".");
    for (let i = 0; i < segs.length; i++) {
      const ext = segs.slice(i).join(".");
      if (manifest.fileExtensions[ext]) return manifest.fileExtensions[ext];
    }
  }
  return manifest.defaultIcon;
}
