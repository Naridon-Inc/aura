// The two reads the Workspaces rows need beyond what the roster already
// carries: where each copy's branch stands against its upstream, and the full
// pull-request record (draft, checks, review) for each repository. Both go
// through the app's shared caches, so this page asking costs nothing when the
// review pane or a hover card asked a moment ago.

import { useEffect, useMemo, useState } from "react";

import type { PrSummary } from "../../lib/api";
import { fetchAheadBehind } from "../../lib/gitStateCache";
import {
  fetchPrList,
  getPrListCached,
  subscribePrList,
} from "../../lib/prsCache";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";
import type { FleetGit } from "./workspacesOverview";
import type { WorkspaceCopy } from "./workspacesModel";

/** How often a visible page re-reads ahead/behind. A push from a terminal
 *  shows up within this window; anything the app itself does announces
 *  `aura:git-changed` and is re-read at once. */
const GIT_REFRESH_MS = 30_000;

/** Reads in flight at once. A fleet of forty copies read all at once would
 *  queue forty git processes behind the terminal's keystrokes. */
const GIT_CONCURRENCY = 4;

export function useFleetGit(copies: WorkspaceCopy[]): {
  git: ReadonlyMap<string, FleetGit>;
  prsByRoot: ReadonlyMap<string, PrSummary[]>;
} {
  const visible = useDocumentVisibility();
  const pathKey = copies.map((c) => c.path).join("\u0000");
  const rootKey = [...new Set(copies.map((c) => c.root))].join("\u0000");
  const paths = useMemo(() => (pathKey ? pathKey.split("\u0000") : []), [pathKey]);
  const roots = useMemo(() => (rootKey ? rootKey.split("\u0000") : []), [rootKey]);

  const [git, setGit] = useState<ReadonlyMap<string, FleetGit>>(new Map());
  const [prsByRoot, setPrs] = useState<ReadonlyMap<string, PrSummary[]>>(
    () => new Map(roots.flatMap((r) => {
      const cached = getPrListCached(r);
      return cached ? [[r, cached] as const] : [];
    })),
  );

  useEffect(() => {
    if (!visible || !paths.length) return;
    let cancelled = false;
    const readAll = async () => {
      const queue = [...paths];
      const worker = async () => {
        for (let path = queue.shift(); path; path = queue.shift()) {
          try {
            const r = await fetchAheadBehind(path);
            if (cancelled) return;
            const next: FleetGit = {
              ahead: r.ahead,
              behind: r.behind,
              hasUpstream: r.has_upstream,
            };
            setGit((was) => {
              const old = was.get(path);
              if (
                old &&
                old.ahead === next.ahead &&
                old.behind === next.behind &&
                old.hasUpstream === next.hasUpstream
              )
                return was;
              const m = new Map(was);
              m.set(path, next);
              return m;
            });
          } catch {
            // An unreadable copy keeps whatever it last said, or nothing: a
            // failed read must not turn into "in sync".
          }
        }
      };
      await Promise.all(Array.from({ length: GIT_CONCURRENCY }, worker));
    };
    void readAll();
    const id = window.setInterval(() => void readAll(), GIT_REFRESH_MS);
    const onChanged = () => void readAll();
    window.addEventListener("aura:git-changed", onChanged);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("aura:git-changed", onChanged);
    };
  }, [paths, visible]);

  useEffect(() => {
    if (!roots.length) return;
    let cancelled = false;
    const put = (root: string, list: PrSummary[]) => {
      if (cancelled) return;
      setPrs((was) => {
        if (was.get(root) === list) return was;
        const m = new Map(was);
        m.set(root, list);
        return m;
      });
    };
    const unsubs = roots.map((root) => {
      const cached = getPrListCached(root);
      if (cached) put(root, cached);
      // A repo with no GitHub remote, or no `gh` login, has no PR list. The
      // rows then fall back to the badge's PR number and state.
      void fetchPrList(root).then((list) => put(root, list)).catch(() => {});
      return subscribePrList(root, (list) => put(root, list));
    });
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [roots]);

  return { git, prsByRoot };
}
