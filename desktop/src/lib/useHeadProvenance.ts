// Module-scoped probe for HEAD's signed manifest. Drives the tiny lock
// badge mounted on every assistant turn — so users can see at a glance
// "this agent is operating in a signed-chain repo" and inspect the
// signer + hashes without leaving the chat.
//
// Strategy: cache `{ sha, manifest }` for the latest commit per repo.
// When HEAD moves (commit lands), `aura_status` style poll picks up the
// new sha and we refetch. Manifests are tried at the same three paths
// ProvenanceReplay uses; missing manifest = unsigned (badge hidden).
//
// Polling: 30s while the document is visible, off when hidden.

import { useEffect, useState } from "react";
import { api } from "./api";
import { useDocumentVisibility } from "./useDocumentVisibility";

export type HeadManifest = {
  sha: string;
  signed: boolean;
  identity: string | null;
  intent_hash: string | null;
  ast_hash: string | null;
  path: string | null;
};

const CACHE = new Map<string, HeadManifest>();
const LISTENERS = new Map<string, Set<(m: HeadManifest | null) => void>>();
const INFLIGHT = new Map<string, Promise<void>>();

function notify(repoRoot: string) {
  const m = CACHE.get(repoRoot) ?? null;
  LISTENERS.get(repoRoot)?.forEach((fn) => fn(m));
}

async function refresh(repoRoot: string): Promise<void> {
  const existing = INFLIGHT.get(repoRoot);
  if (existing) return existing;
  const p = (async () => {
    try {
      const list = await api.gitRecentCommits(repoRoot, 1);
      const head = list[0];
      if (!head) return;
      const cached = CACHE.get(repoRoot);
      if (cached?.sha === head.sha) return;
      const manifest = await probe(repoRoot, head.sha);
      CACHE.set(repoRoot, manifest);
      notify(repoRoot);
    } catch {
      /* offline / no git — leave cache as-is */
    } finally {
      INFLIGHT.delete(repoRoot);
    }
  })();
  INFLIGHT.set(repoRoot, p);
  return p;
}

async function probe(repoRoot: string, sha: string): Promise<HeadManifest> {
  for (const candidate of [
    `${repoRoot}/.aura/manifest/${sha}.json`,
    `${repoRoot}/.aura/manifests/${sha}.json`,
    `${repoRoot}/.aura/blocks/${sha}.json`,
  ]) {
    try {
      const body = await api.readFile(candidate);
      if (body.status !== "ok" || !body.text) continue;
      const parsed = JSON.parse(body.text) as Record<string, unknown>;
      return {
        sha,
        signed: true,
        identity: pickStr(parsed, ["signed_by", "identity", "signer", "author_identity"]),
        intent_hash: pickStr(parsed, ["intent_hash", "intent_sha", "stated_hash"]),
        ast_hash: pickStr(parsed, ["ast_hash", "delta_hash", "actual_hash"]),
        path: candidate,
      };
    } catch {
      /* try next candidate */
    }
  }
  return {
    sha,
    signed: false,
    identity: null,
    intent_hash: null,
    ast_hash: null,
    path: null,
  };
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

export function useHeadProvenance(repoRoot: string | undefined): HeadManifest | null {
  const [snap, setSnap] = useState<HeadManifest | null>(
    () => (repoRoot ? CACHE.get(repoRoot) ?? null : null),
  );
  const visible = useDocumentVisibility();

  useEffect(() => {
    if (!repoRoot) {
      setSnap(null);
      return;
    }
    setSnap(CACHE.get(repoRoot) ?? null);
    let bag = LISTENERS.get(repoRoot);
    if (!bag) {
      bag = new Set();
      LISTENERS.set(repoRoot, bag);
    }
    const fn = (m: HeadManifest | null) => setSnap(m);
    bag.add(fn);
    void refresh(repoRoot);
    return () => {
      bag?.delete(fn);
      if (bag && bag.size === 0) LISTENERS.delete(repoRoot);
    };
  }, [repoRoot]);

  useEffect(() => {
    if (!repoRoot || !visible) return;
    const id = window.setInterval(() => void refresh(repoRoot), 30_000);
    return () => window.clearInterval(id);
  }, [repoRoot, visible]);

  return snap;
}
