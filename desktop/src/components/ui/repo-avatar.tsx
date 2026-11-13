import { useEffect, useRef, useState, type ReactNode } from "react";
import { Folder } from "lucide-react";
import { cn } from "../../lib/utils";
import "./repo-avatar.css";

/** What a repository picture shows, best first: the emoji the person picked,
 *  the icon they picked (a named glyph or an uploaded image), the repository's
 *  own icon file, its GitHub owner's face, then the fallback. An image that
 *  failed to load is skipped for the next one down. */
export type RepoAvatarSource =
  | { kind: "emoji"; emoji: string }
  | { kind: "glyph" }
  | { kind: "picked"; src: string }
  | { kind: "icon"; src: string }
  | { kind: "avatar"; src: string }
  | { kind: "fallback" };

export function pickRepoAvatarSource(input: {
  emoji?: string | null;
  glyph?: boolean;
  picked?: string | null;
  icon?: string | null;
  avatar?: string | null;
  failed?: ReadonlySet<string>;
}): RepoAvatarSource {
  const emoji = input.emoji?.trim();
  if (emoji) return { kind: "emoji", emoji };
  if (input.glyph) return { kind: "glyph" };
  const failed = input.failed;
  if (input.picked && !failed?.has(input.picked)) return { kind: "picked", src: input.picked };
  if (input.icon && !failed?.has(input.icon)) return { kind: "icon", src: input.icon };
  if (input.avatar && !failed?.has(input.avatar)) return { kind: "avatar", src: input.avatar };
  return { kind: "fallback" };
}

/** Images that have finished loading once this run. A row that remounts with
 *  one of these draws it on the first frame instead of the fallback. */
const loadedOnce = new Set<string>();

export type RepoAvatarProps = {
  /** The repository's name, read by assistive tech when the picture stands alone. */
  name: string;
  emoji?: string | null;
  /** A named icon the person picked, drawn at the picture's size. */
  glyph?: ReactNode;
  /** An image the person picked, as a URL. Drawn square. */
  picked?: string | null;
  /** The repository's own icon, usually a `data:` URL. Drawn square. */
  icon?: string | null;
  /** The owner's avatar URL. Drawn with rounded corners. */
  avatar?: string | null;
  /** Edge in px. Defaults to 16. */
  size?: number;
  /** Shown until an image loads, and when there is none. Defaults to a folder. */
  fallback?: ReactNode;
  /** Label the picture for assistive tech; off when the name sits beside it. */
  labelled?: boolean;
  className?: string;
};

export function RepoAvatar({
  name,
  emoji,
  glyph,
  picked,
  icon,
  avatar,
  size = 16,
  fallback,
  labelled = false,
  className,
}: RepoAvatarProps) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const source = pickRepoAvatarSource({ emoji, glyph: !!glyph, picked, icon, avatar, failed });
  const src =
    source.kind === "picked" || source.kind === "icon" || source.kind === "avatar"
      ? source.src
      : null;
  const [loaded, setLoaded] = useState<string | null>(() =>
    src && loadedOnce.has(src) ? src : null,
  );
  const img = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!src) return;
    if (loadedOnce.has(src)) {
      setLoaded(src);
      return;
    }
    const el = img.current;
    if (el?.complete && el.naturalWidth > 0) {
      loadedOnce.add(src);
      setLoaded(src);
    }
  }, [src]);

  const showing = src !== null && loaded === src;
  const fallbackNode = fallback ?? <Folder size={size} />;
  const label = labelled ? name : undefined;

  if (source.kind === "emoji") {
    return (
      <span
        className={cn("ui-repo-avatar", className)}
        data-kind="emoji"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.875) }}
        role={label ? "img" : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
      >
        {source.emoji}
      </span>
    );
  }

  if (source.kind === "glyph") {
    return (
      <span
        className={cn("ui-repo-avatar", className)}
        data-kind="glyph"
        style={{ width: size, height: size }}
        role={label ? "img" : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
      >
        {glyph}
      </span>
    );
  }

  return (
    <span
      className={cn("ui-repo-avatar", className)}
      data-kind={showing ? source.kind : "fallback"}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {!showing && <span className="ui-repo-avatar-fallback">{fallbackNode}</span>}
      {src && (
        <img
          key={src}
          ref={img}
          src={src}
          alt=""
          width={size}
          height={size}
          draggable={false}
          decoding="async"
          data-shape={source.kind === "avatar" ? "rounded" : "square"}
          data-state={showing ? "loaded" : "loading"}
          onLoad={() => {
            loadedOnce.add(src);
            setLoaded(src);
          }}
          onError={() => {
            setFailed((prev) => new Set(prev).add(src));
          }}
        />
      )}
    </span>
  );
}
