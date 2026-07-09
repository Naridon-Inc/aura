// Port of superset-sh/superset's file-icon generator. Reads
// material-icon-theme's manifest, then copies just the SVGs the
// manifest references into public/file-icons/, plus a condensed
// JSON map the renderer reads at runtime.
//
// Run with: bun run scripts/generate-file-icons.mjs

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateManifest } from "material-icon-theme";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_DIR = resolve(ROOT, "public/file-icons");
const ICONS_SRC = resolve(ROOT, "node_modules/material-icon-theme/icons");

const manifest = generateManifest({
  activeIconPack: "react",
  folders: { theme: "specific" },
});

const referenced = new Set();
const add = (n) => { if (n) referenced.add(n); };

add(manifest.file);
add(manifest.folder);
add(manifest.folderExpanded);
add(manifest.rootFolder);
add(manifest.rootFolderExpanded);

for (const v of Object.values(manifest.fileNames ?? {})) add(v);
for (const v of Object.values(manifest.fileExtensions ?? {})) add(v);
for (const v of Object.values(manifest.languageIds ?? {})) add(v);
for (const v of Object.values(manifest.folderNames ?? {})) add(v);
for (const v of Object.values(manifest.folderNamesExpanded ?? {})) add(v);

const condensed = {
  fileNames: manifest.fileNames ?? {},
  fileExtensions: manifest.fileExtensions ?? {},
  folderNames: manifest.folderNames ?? {},
  folderNamesExpanded: manifest.folderNamesExpanded ?? {},
  defaultIcon: manifest.file ?? "file",
  defaultFolderIcon: manifest.folder ?? "folder",
  defaultFolderOpenIcon: manifest.folderExpanded ?? "folder-open",
};

// VS Code's languageIds aren't ours; fold the common ones into extensions.
const langExtFold = {
  ts: "typescript",
  js: "javascript",
  php: "php",
  tex: "tex",
  m: "matlab",
  diff: "diff",
  patch: "diff",
};
for (const [ext, icon] of Object.entries(langExtFold)) {
  if (!condensed.fileExtensions[ext]) {
    condensed.fileExtensions[ext] = icon;
    referenced.add(icon);
  }
}

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

let copied = 0;
for (const name of referenced) {
  const src = resolve(ICONS_SRC, `${name}.svg`);
  const dest = resolve(OUT_DIR, `${name}.svg`);
  if (existsSync(src)) {
    cpSync(src, dest);
    copied++;
  }
}

writeFileSync(
  resolve(OUT_DIR, "manifest.json"),
  JSON.stringify(condensed, null, 2),
);

console.log(
  `file-icons: ${copied} svgs, ${Object.keys(condensed.fileNames).length} names, ${Object.keys(condensed.fileExtensions).length} exts, ${Object.keys(condensed.folderNames).length} folders`,
);
