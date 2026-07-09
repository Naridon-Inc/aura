// folderColors — the small, tasteful palette people pick from when coloring a
// Pages folder. Folder color is a user organizational label (not app status),
// so a muted multi-hue set is appropriate here. The default is a calm blue —
// the familiar tinted-folder look — NOT green (green is reserved app-wide for
// status). The accent token leads the list as the primary, on-brand choice.
//
// Each swatch resolves to a CSS color used two ways on a folder row:
//   • `tint`   — the folder glyph fill (full-strength swatch)
//   • `soft`   — a low-alpha wash behind an expanded/active folder row
// We derive `soft` from `tint` via color-mix so a new swatch needs only one
// value. Tokens are opaque short strings persisted in the backend folder index,
// so renaming a swatch here never invalidates stored folders (an unknown token
// just falls back to the default blue).

export type FolderColorToken =
  | "blue"
  | "slate"
  | "violet"
  | "teal"
  | "amber"
  | "rose"
  | "green";

export type FolderColor = {
  token: FolderColorToken;
  /** Plain-language label for the picker tooltip / a11y. */
  label: string;
  /** Full-strength swatch — the folder glyph fill. */
  tint: string;
};

// Ordered for the picker. Blue (the Dropbox-ish default) leads. It is a
// LITERAL arctic blue, not the `--color-accent` token — accent is remapped
// per-surface (green inside chat scopes, etc.) so binding the default folder
// to it made folders render the wrong hue. A fixed blue guarantees the
// familiar tinted-folder look everywhere. The rest are calm, muted
// organizational hues.
export const FOLDER_COLORS: FolderColor[] = [
  { token: "blue", label: "Blue", tint: "#4c8dff" },
  { token: "slate", label: "Slate", tint: "#8a93a6" },
  { token: "violet", label: "Violet", tint: "#a78bfa" },
  { token: "teal", label: "Teal", tint: "#5eb8b3" },
  { token: "amber", label: "Amber", tint: "#d9a441" },
  { token: "rose", label: "Rose", tint: "#e07b94" },
  { token: "green", label: "Green", tint: "#6fbf73" },
];

export const DEFAULT_FOLDER_COLOR: FolderColorToken = "blue";

const BY_TOKEN: Record<string, FolderColor> = Object.fromEntries(
  FOLDER_COLORS.map((c) => [c.token, c]),
);

/** Resolve a stored token to its swatch, falling back to the default blue for
 *  an unknown/empty token so old or hand-edited indexes never render blank. */
export function folderColor(token: string | null | undefined): FolderColor {
  return (token && BY_TOKEN[token]) || BY_TOKEN[DEFAULT_FOLDER_COLOR];
}

/** The folder glyph fill for a token. */
export function folderTint(token: string | null | undefined): string {
  return folderColor(token).tint;
}

/** A low-alpha wash of the folder color for an expanded/active row background.
 *  Derived from the tint via color-mix so each swatch needs only one value. */
export function folderSoftBg(token: string | null | undefined): string {
  return `color-mix(in srgb, ${folderTint(token)} 12%, transparent)`;
}
