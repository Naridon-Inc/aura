// Everything the Code Map knows and can do, apart from drawing it: which
// view is up, the bounded slice of the graph on screen, the filters that
// shape that slice, the selection and what it connects to, and the chain
// search between two pieces. The slice is asked for server-side and never
// the whole graph; a newer request always wins over a slower older one.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type KgExplain,
  type KgExplainEdge,
  type KgPath,
  type KgView,
  type KgViewQuery,
} from "../../../lib/api";
import type { SelectedLink } from "./graphModel";

export type GraphMode = "features" | "pieces";

export function useGraphView(repoRoot: string) {
  // The map lands on FEATURES — plain-language blocks anyone can read.
  // "Pieces" is the raw symbol network underneath, reached by toggling or
  // by drilling into a feature.
  const [mode, setMode] = useState<"features" | "pieces">("features");
  const [featureRebuild, setFeatureRebuild] = useState(0);
  const [view, setView] = useState<KgView | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [includeDocs, setIncludeDocs] = useState(false);
  const [kindFilter, setKindFilter] = useState<Set<string>>(
    new Set(["fn", "class", "type", "file"]),
  );
  const [communityFilter, setCommunityFilter] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  // Incremental loading: when set, the view is the BFS neighbourhood of
  // this node instead of the global ranking.
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fitSelectionSignal, setFitSelectionSignal] = useState(0);
  const [explain, setExplain] = useState<KgExplain | null>(null);
  const [pathResult, setPathResult] = useState<KgPath | null>(null);
  const [pathBusy, setPathBusy] = useState(false);

  // Monotonic request sequence so a slow response can never clobber a
  // newer one; hasViewRef separates first-load from filter refinement.
  const requestSeq = useRef(0);
  const hasViewRef = useRef(false);

  const buildViewQuery = useCallback(
    (): KgViewQuery => ({
      query: search.trim(),
      // The backend's kind filter is a plain allow-list, so the docs
      // toggle rides in as extra kinds.
      kinds: [...kindFilter, ...(includeDocs ? ["doc", "section"] : [])],
      community: communityFilter,
      include_docs: includeDocs,
      focus: focusId,
    }),
    [search, kindFilter, communityFilter, includeDocs, focusId],
  );

  const fetchView = useCallback(
    async (opts?: { rebuild?: boolean }) => {
      const seq = ++requestSeq.current;
      setErr(null);
      try {
        if (opts?.rebuild) {
          setBuilding(true);
          await api.auraKgEnsure(repoRoot, true);
        }
        let v = await api.auraKgView(repoRoot, buildViewQuery());
        if (v === null) {
          // No graph on disk yet: build once (stats-only handshake — the
          // graph itself stays server-side), then ask again.
          setBuilding(true);
          await api.auraKgEnsure(repoRoot, false);
          v = await api.auraKgView(repoRoot, buildViewQuery());
        }
        if (seq !== requestSeq.current) return;
        if (v) {
          setView(v);
          hasViewRef.current = true;
        }
      } catch (e) {
        if (seq === requestSeq.current) setErr(String(e));
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setBuilding(false);
        }
      }
    },
    [repoRoot, buildViewQuery],
  );

  // First load fires immediately; later filter/search changes debounce so
  // a keystroke burst costs one IPC round-trip, not one per key. The pieces
  // view only fetches while it is the one on screen — the feature map owns
  // its own loading.
  useEffect(() => {
    if (mode !== "pieces") return;
    if (!hasViewRef.current) {
      void fetchView();
      return;
    }
    const t = setTimeout(() => void fetchView(), 250);
    return () => clearTimeout(t);
  }, [fetchView, mode]);

  const refresh = useCallback(
    (force: boolean) => void fetchView({ rebuild: force }),
    [fetchView],
  );

  const gods = useMemo(() => {
    if (!view) return [];
    return [...view.nodes]
      .filter((n) => n.god)
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 10);
  }, [view]);

  const surprises = useMemo(() => {
    if (!view) return [];
    return view.edges.filter((e) => e.surprise).slice(0, 10);
  }, [view]);

  const graphNodeById = useMemo(() => {
    return new Map((view?.nodes ?? []).map((n) => [n.id, n] as const));
  }, [view]);

  const selectedNode =
    (selectedId ? graphNodeById.get(selectedId) : null) ??
    (explain && explain.node.id === selectedId ? explain.node : null);

  // Selection details come from the backend — explain sees every edge in
  // the whole graph, not just the loaded slice.
  useEffect(() => {
    setPathResult(null);
    if (!selectedId) {
      setExplain(null);
      return;
    }
    let alive = true;
    api
      .auraKgExplain(repoRoot, selectedId)
      .then((ex) => {
        if (alive) setExplain(ex);
      })
      .catch(() => {
        /* keep the local fallback below */
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, selectedId]);

  const selectedLinks = useMemo<SelectedLink[]>(() => {
    if (!selectedId) return [];
    if (explain && explain.node.id === selectedId) {
      const toLinks = (edges: KgExplainEdge[], direction: "in" | "out") =>
        edges.map(
          (e) =>
            ({
              edge: {
                from: direction === "out" ? selectedId : e.other.id,
                to: direction === "out" ? e.other.id : selectedId,
                kind: e.kind,
                surprise: e.surprise,
              },
              other: e.other,
              direction,
            }) satisfies SelectedLink,
        );
      return [...toLinks(explain.inbound, "in"), ...toLinks(explain.outbound, "out")]
        .sort((a, b) => {
          if (a.edge.surprise !== b.edge.surprise) {
            return a.edge.surprise ? -1 : 1;
          }
          return b.other.degree - a.other.degree;
        })
        .slice(0, 24);
    }
    // Fallback while explain is in flight: the bounded view's own edges.
    if (!view) return [];
    return view.edges
      .map((edge) => {
        if (edge.from !== selectedId && edge.to !== selectedId) return null;
        const isOut = edge.from === selectedId;
        const other = graphNodeById.get(isOut ? edge.to : edge.from);
        if (!other) return null;
        return {
          edge,
          other,
          direction: isOut ? "out" : "in",
        } satisfies SelectedLink;
      })
      .filter((x): x is SelectedLink => Boolean(x))
      .sort((a, b) => {
        if (a.edge.surprise !== b.edge.surprise) {
          return a.edge.surprise ? -1 : 1;
        }
        return b.other.degree - a.other.degree;
      })
      .slice(0, 12);
  }, [explain, view, graphNodeById, selectedId]);

  const selectNode = useCallback(
    (id: string, opts?: { fit?: boolean }) => {
      setSelectedId(id);
      if (opts?.fit) setFitSelectionSignal((n) => (n + 1) & 0xffff);
      const n = graphNodeById.get(id);
      if (!n) return;
      window.dispatchEvent(
        new CustomEvent("aura:open-file", {
          detail: { path: n.file, line: n.line > 0 ? n.line : undefined },
        }),
      );
    },
    [graphNodeById],
  );

  const runPath = useCallback(
    async (to: string) => {
      if (!selectedId || !to.trim()) return;
      setPathBusy(true);
      try {
        const p = await api.auraKgPath(repoRoot, selectedId, to.trim(), 8);
        setPathResult(p);
      } catch (e) {
        setErr(String(e));
      } finally {
        setPathBusy(false);
      }
    },
    [repoRoot, selectedId],
  );

  const focusNode = useCallback(
    (id: string) => selectNode(id, { fit: true }),
    [selectNode],
  );

  const toggleKind = useCallback((k: string) => {
    setKindFilter((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const rebuild = useCallback(() => {
    if (mode === "features") setFeatureRebuild((n) => n + 1);
    else refresh(true);
  }, [mode, refresh]);

  return {
    mode,
    setMode,
    featureRebuild,
    rebuild,
    view,
    loading,
    building,
    err,
    includeDocs,
    setIncludeDocs,
    kindFilter,
    toggleKind,
    communityFilter,
    setCommunityFilter,
    search,
    setSearch,
    focusId,
    setFocusId,
    hoverId,
    setHoverId,
    selectedId,
    setSelectedId,
    fitSelectionSignal,
    explain,
    pathResult,
    setPathResult,
    pathBusy,
    gods,
    surprises,
    graphNodeById,
    selectedNode,
    selectedLinks,
    selectNode,
    focusNode,
    runPath,
  };
}

export type GraphView = ReturnType<typeof useGraphView>;
