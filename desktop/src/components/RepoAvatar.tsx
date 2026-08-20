// RepoAvatar — the glyph that fronts a workspace/project in the rail and
// roster. Render priority, highest first:
//
//   1. An explicit emoji the user picked (emoji always wins — it's a
//      deliberate choice and overrides the auto-derived avatar).
//   2. The repo owner's GitHub avatar (`https://github.com/<owner>.png`),
//      resolved+cached by `lib/repoAvatar.ts`. Both users and orgs serve
//      one, so a GitHub-hosted repo reads as its owner's face/logo.
//   3. The `fallback` node — a folder glyph or the project's letter — for
//      non-GitHub repos, 404s, or while the owner is still resolving.
//
// The avatar is loaded with an `<img onError>` guard (modelled on
// settings/IntegrationsTab.tsx's identity avatar) so a dead/forbidden URL
// degrades silently to the fallback instead of showing a broken image.

import { useEffect, useState } from "react";
import { cachedRepoAvatar, resolveRepoAvatar } from "../lib/repoAvatar";

export function RepoAvatar({
  repoRoot,
  emoji,
  letter,
  size,
  fallback,
}: {
  repoRoot: string;
  /** User-picked glyph. When set it wins outright — no avatar lookup. */
  emoji?: string;
  /** Single-char monogram, used only by callers that pass it as their
   *  fallback; RepoAvatar itself renders `fallback` for the no-avatar
   *  case. Kept on the props so call sites read symmetrically. */
  letter?: string;
  /** Square edge in px. The image is rounded to match the host tile. */
  size: number;
  /** What to show when there's no emoji and no usable avatar. */
  fallback: React.ReactNode;
}) {
  // Seed from the synchronous cache so a known repo paints its avatar on
  // the first frame with no flicker.
  const [src, setSrc] = useState<string | null>(() =>
    emoji ? null : cachedRepoAvatar(repoRoot),
  );
  // The <img> failed to load (404 / not GitHub / offline) → drop to
  // fallback for this render even if a URL was cached.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (emoji) return; // emoji wins — skip the lookup entirely
    let alive = true;
    setFailed(false);
    // Repaint immediately from cache when the root changes, then resolve.
    setSrc(cachedRepoAvatar(repoRoot));
    void resolveRepoAvatar(repoRoot).then((url) => {
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [repoRoot, emoji]);

  if (emoji) {
    return <span style={{ fontSize: Math.round(size * 0.95) }}>{emoji}</span>;
  }

  if (src && !failed) {
    // Tile corners are gently rounded (~22% of the edge), so the avatar
    // sits inside them rather than poking out as a hard square.
    const radius = Math.max(3, Math.round(size * 0.22));
    return (
      <img
        src={src}
        alt={letter ?? ""}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          objectFit: "cover",
          display: "block",
        }}
      />
    );
  }

  return <>{fallback}</>;
}

// A project's own hue, derived from its repo root with FNV-1a.
//
// Deliberately the SAME hash and the same `hsl()` formula the Workspaces view
// carries for its project chips (components/workspaces/WorkspacesBits.tsx →
// `folderTint`), and seeded from the same value — the owning project root —
// so a project resolves to one hue rather than two schemes drifting apart.
//
// Worth knowing before you trust that: `folderTint` is currently unreachable.
// `ProjectGlyph` picks `accent || folderTint(root)`, and every call site feeds
// it `accentForRoot()`, which returns a non-empty neutral for every project —
// so the accent always wins and those chips are all one colour today. The
// alignment here is therefore latent, not visible: matching the formula means
// that the day the neutral override is dropped the two surfaces already agree,
// instead of someone having to reconcile two hashes after the fact.
//
// `accentForRoot` (lib/workspaceRef.ts) is not reused for the same
// reason it can't be trusted above: it was deliberately flattened to one
// neutral for all roots, so it carries no per-project identity — passing it in
// would tint every tile identically. Its history is the warning label on this
// function, though. The rail used to hash roots into eight FULL-strength hues
// and the list read as a paint chart. Hence 24% saturation here, and hence the
// letter staying on the text ramp below rather than taking the hue.
function projectHue(root: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < root.length; i++) {
    h ^= root.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `hsl(${(h >>> 0) % 360} 24% 62%)`;
}

/** The default project mark: a rounded tile carrying the project's initial.
 *
 *  This replaces the folder glyph that used to stand in whenever no owner
 *  avatar resolved. A folder says "a directory on your disk" — which was
 *  honest when a project might have been any old folder, but every project
 *  now has a repository behind it, so the mark should say "a project" and
 *  should differ between projects. One folder icon repeated down a list
 *  distinguishes nothing; an initial does, and it matches the monogram
 *  discs people already carry elsewhere in the app.
 *
 *  The tile carries a wash of the project's hue so a column of them is
 *  scannable before you read a single letter. Kept at a 16% mix INTO
 *  `--color-bg-3` rather than over transparent: mixing against the surface
 *  token means the tile follows the theme (it lifts off the dark grounds and
 *  settles into the light one) instead of needing a per-theme value, and 16%
 *  of a 24%-saturation hue lands about a hue step apart between neighbours —
 *  enough to tell two tiles apart, nowhere near enough to compete with
 *  arctic-blue affordances, teal/green status or agent orange, which is the
 *  reason the saturation is held down rather than the mix alone. */
export function ProjectMark({
  name,
  root,
  size,
}: {
  name: string;
  /** Repo root — the hue seed. Required rather than defaulted to `name` so a
   *  tile can never silently disagree with the same project's chip in the
   *  Workspaces view, which seeds from the root too. */
  root: string;
  size: number;
}) {
  const letter = (name.trim().charAt(0) || "?").toUpperCase();
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center font-medium"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(3, Math.round(size * 0.22)),
        background: `color-mix(in srgb, ${projectHue(root)} 16%, var(--color-bg-3))`,
        // The letter stays on the neutral text ramp. Tinting it too would
        // double the colour on a 15px tile and take it straight back to the
        // paint chart the rail was pulled out of.
        color: "var(--color-text-2)",
        // Track the tile so the letter stays optically centred at 15px and
        // at 32px without a second size prop.
        fontSize: Math.max(8, Math.round(size * 0.58)),
        lineHeight: 1,
      }}
    >
      {letter}
    </span>
  );
}
