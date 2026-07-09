// Branded SVG icon for a file or folder name. Resolves via the
// material-icon-theme manifest generated at build time. Manifest is
// fetched once on first mount; subsequent renders read from a cache.

import { useEffect, useState } from "react";
import { iconUrl, loadIconManifest, resolveIconName } from "../lib/fileIcons";

type Props = {
  name: string;
  isDirectory?: boolean;
  isOpen?: boolean;
  size?: number;
  className?: string;
};

export function FileIcon({
  name,
  isDirectory = false,
  isOpen = false,
  size = 14,
  className,
}: Props) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadIconManifest().then((m) => {
      if (!alive) return;
      setSrc(iconUrl(resolveIconName(m, name, isDirectory, isOpen)));
    });
    return () => {
      alive = false;
    };
  }, [name, isDirectory, isOpen]);

  return (
    <img
      src={src ?? undefined}
      alt=""
      draggable={false}
      width={size}
      height={size}
      className={className}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        visibility: src ? "visible" : "hidden",
      }}
    />
  );
}
