// What the proof trail knows about a commit's evidence, and how it reads it.
//
// A commit is paired with whatever signed manifest lives at
// `.aura/manifest{,s}/<sha>.json` or `.aura/blocks/<sha>.json`. The probe reads
// just enough of it to show who signed and the two canonical hashes; checking
// the signature is the CLI's job, run when someone presses Verify.

import { api } from "../../../lib/api";
import type { TraceTone } from "../../ui/trace-report";

/** How far back the commit rail reads. Baked into the cache key so changing it
 *  can't silently read a shorter bundle. */
export const COMMIT_DEPTH = 80;

// "checking" is the honest gap the lazy probe opens up: we haven't read this
// commit's evidence off disk yet, which is NOT the same claim as "unsigned".
export type ManifestStatus =
  | "checking"
  | "signed"
  | "unsigned"
  | "verifying"
  | "ok"
  | "fail";

export type ManifestRecord = {
  status: ManifestStatus;
  path: string | null;
  identity: string | null;
  intent_hash: string | null;
  ast_hash: string | null;
  detail: string | null;
};

export const EMPTY: ManifestRecord = {
  status: "unsigned",
  path: null,
  identity: null,
  intent_hash: null,
  ast_hash: null,
  detail: null,
};

// ── resourceCache keys ────────────────────────────────────────────────
// All repo-scoped, all process-lifetime. Nothing here rewrites itself once
// written (a commit's diff and its manifest are immutable), so a cache hit is
// as true as a fresh read — only the commit LIST can grow, and that refreshes
// on every mount.

export function commitsKey(repoRoot: string): string {
  return `commits:recent:${repoRoot}:${COMMIT_DEPTH}`;
}

export function changeIdsKey(repoRoot: string): string {
  return `changeIds:${repoRoot}:${COMMIT_DEPTH}`;
}

export function manifestKey(repoRoot: string, sha: string): string {
  return `manifest:${repoRoot}:${sha}`;
}

export function diffKey(repoRoot: string, sha: string): string {
  return `commitDiff:${repoRoot}:${sha}`;
}

/** The status glyph a record reads with. A pin we haven't read yet looks the
 *  same as one with nothing to show (muted); the words draw the distinction. */
export function statusTone(status: ManifestStatus): TraceTone {
  switch (status) {
    case "ok":
    case "signed":
      return "good";
    case "verifying":
      return "warn";
    case "fail":
      return "bad";
    case "checking":
    case "unsigned":
    default:
      return "muted";
  }
}

export function statusHint(s: ManifestStatus): string {
  switch (s) {
    case "ok":
      return "Verified evidence";
    case "signed":
      return "Signed evidence · not checked";
    case "verifying":
      return "Checking evidence…";
    case "fail":
      return "Evidence check failed";
    case "checking":
      return "Looking for evidence…";
    case "unsigned":
    default:
      return "No signed evidence";
  }
}

// Probe `.aura/manifest/<sha>.json` first, then `manifests/`, then
// `.aura/blocks/<sha>.json`. All three layouts are tolerated since
// the signing infra is still settling. If we find a JSON file, parse
// just enough to surface identity + canonical hashes; the full
// verification step happens via the CLI when the user clicks Verify.
export async function probeManifest(
  repoRoot: string,
  sha: string,
): Promise<ManifestRecord> {
  for (const candidate of [
    `${repoRoot}/.aura/manifest/${sha}.json`,
    `${repoRoot}/.aura/manifests/${sha}.json`,
    `${repoRoot}/.aura/blocks/${sha}.json`,
  ]) {
    try {
      const body = await api.readFile(candidate);
      if (body.status !== "ok" || !body.text) continue;
      const parsed = JSON.parse(body.text) as Record<string, unknown>;
      const identity = pickStr(parsed, [
        "signed_by",
        "identity",
        "signer",
        "author_identity",
      ]);
      const intentHash = pickStr(parsed, [
        "intent_hash",
        "intent_sha",
        "stated_hash",
      ]);
      const astHash = pickStr(parsed, [
        "ast_hash",
        "delta_hash",
        "actual_hash",
      ]);
      return {
        status: "signed",
        path: candidate,
        identity,
        intent_hash: intentHash,
        ast_hash: astHash,
        detail: null,
      };
    } catch {
      /* try next candidate */
    }
  }
  return EMPTY;
}

function pickStr(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** One file's part of a commit's patch. */
export type CommitFilePatch = { path: string; patch: string };

/** `git show --stat -p` output, read apart: the message body under the
 *  subject, and each file's patch. Text with no file sections (git's own error
 *  text, or a commit that changed no files) comes back as `rest`, unread. */
export function splitCommitShow(text: string): {
  body: string;
  files: CommitFilePatch[];
  rest: string;
} {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((l) => /^diff --(?:git|cc|combined) /.test(l));
  const head = first === -1 ? lines : lines.slice(0, first);
  // The message is git's 4-space indented block; its first line is the
  // subject, which the page already shows as the title.
  const message = head.filter((l) => l.startsWith("    ")).map((l) => l.slice(4));
  const body = message.slice(1).join("\n").trim();
  if (first === -1) {
    const looksLikeShow = lines[0]?.startsWith("commit ");
    return { body, files: [], rest: looksLikeShow ? "" : text.trim() };
  }
  const files: CommitFilePatch[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const line of lines.slice(first)) {
    const header = /^diff --(?:git a\/.* b\/(.*)|cc (.*)|combined (.*))$/.exec(line);
    if (header) {
      if (current) files.push({ path: current.path, patch: current.lines.join("\n") });
      current = { path: header[1] ?? header[2] ?? header[3] ?? line, lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) files.push({ path: current.path, patch: current.lines.join("\n") });
  return { body, files, rest: "" };
}

/** A commit message body as paragraphs, unwrapped. Git bodies are hard-wrapped
 *  at ~72 columns, which reads as ragged breaks in any narrower column, so
 *  lines in a paragraph rejoin; a list item ("- ", "* ", "1. ") starts a new
 *  line and its indented continuation lines rejoin it. */
export function messageParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((block) => {
      const out: string[] = [];
      for (const raw of block.split("\n")) {
        const line = raw.trimEnd();
        if (!line.trim()) continue;
        const item = /^\s*(?:[-*•]|\d+[.)])\s/.test(line);
        if (item || out.length === 0) out.push(line.trim());
        else out[out.length - 1] += ` ${line.trim()}`;
      }
      return out.join("\n");
    })
    .filter(Boolean);
}
