// The named icon set, loaded once on first use. Until it arrives a reader gets
// null and draws what it would draw without a picked icon.

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";

type IconSet = {
  REPO_ICONS: Readonly<Record<string, LucideIcon>>;
  REPO_ICON_NAMES: readonly string[];
};

let loaded: IconSet | null = null;
let loading: Promise<IconSet> | null = null;

export function loadRepoIcons(): Promise<IconSet> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import("./repoIconSet").then((m) => {
    loaded = m;
    return m;
  });
  return loading;
}

/** The icon set, or null while it loads. `wanted` false asks for nothing. */
export function useRepoIcons(wanted = true): IconSet | null {
  const [set, setSet] = useState<IconSet | null>(loaded);
  useEffect(() => {
    if (!wanted || set) return;
    let alive = true;
    void loadRepoIcons().then((m) => {
      if (alive) setSet(m);
    });
    return () => {
      alive = false;
    };
  }, [wanted, set]);
  return set;
}
