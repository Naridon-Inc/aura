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
