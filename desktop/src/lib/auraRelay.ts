// Aura Relay — the "share to channel" primitive.
//
// Any Aura artifact (an intent log entry, a snapshot, a commit, a PR
// review verdict, a function reference, a goal-trace result) can be
// fired into a chat channel as a *structured* payload. The channel
// renderer recognises the sentinel marker, parses the JSON, and draws
// a rich card instead of a plain text bubble.
//
// Wire format follows the existing chat sentinels (`<aura:attachments>`,
// `<aura:repofiles>`) for symmetry — a leading human-readable preview
// line so naïve clients still show something useful, followed by the
// sentinel block on a new line:
//
//     [aura-relay] /intent — Refactored retry_logic to use exponential backoff
//     <aura:relay>{"kind":"intent","payload":{ ... },"v":1}</aura:relay>
//
// Receivers that parse the sentinel hide the leading preview line and
// render the card; receivers that don't parse it still see the preview
// line so the message is never empty.
//
// We deliberately keep payloads tiny — references only, never raw file
// content. The card renderer fetches details on demand.

import { api, type ChatMessage } from "./api";

// ─── Payload schemas ─────────────────────────────────────────────────

export type IntentRelayPayload = {
  /** Unix-seconds timestamp — doubles as the intent id in `.aura/intent_log.jsonl`. */
  ts: number;
  subject: string;
  agent_id?: string;
  branch?: string;
  /** Bounded file paths from the intent's changeset, if any. */
  files?: string[];
};

export type SnapshotRelayPayload = {
  /** Absolute or repo-relative file path the snapshot belongs to. */
  path: string;
  /** Snapshot id / short sha if available — used for the unfurl lookup. */
  id?: string;
  /** Capture timestamp (unix seconds). */
  ts?: number;
};

export type CommitRelayPayload = {
  sha: string;
  subject: string;
  author?: string;
  ts?: number;
  branch?: string;
};

export type ProveRelayPayload = {
  goal: string;
  /** Whether the goal-trace believed the codebase supports the goal. */
  ok: boolean;
  /** Count of logic nodes that satisfied the trace. */
  nodes_matched?: number;
  /** Optional gap list — function names the trace flagged as missing. */
  gaps?: string[];
};

export type PrReviewRelayPayload = {
  base: string;
  /** "ok" = clean, "warn" = soft violations, "fail" = blocker. */
  verdict: "ok" | "warn" | "fail";
  violations?: number;
  undocumented?: number;
  /** Optional one-line headline ("3 violations across 2 files"). */
  headline?: string;
};

export type FunctionRefRelayPayload = {
  path: string;
  name: string;
  /** Optional line range for editor jump. */
  line?: number;
};

export type PrOpenedRelayPayload = {
  /** "owner/name" */
  repo: string;
  /** Permalink to the PR. */
  url: string;
  number: number;
  title: string;
  /** GitHub login or display name. */
  author: string;
  base_branch: string;
  head_branch: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
};

export type PrLineRelayPayload = {
  /** "owner/name" */
  repo: string;
  /** Permalink to the line range on github. */
  url: string;
  /** PR number this snippet belongs to. */
  number: number;
  /** Path in the repo. */
  file: string;
  line_start: number;
  line_end: number;
  /** Raw code body — rendered in a fenced block by the card. */
  snippet: string;
  /** Hint for syntax highlight / chip label (e.g. "rust", "ts"). */
  language?: string;
};

export type RelayKind =
  | "intent"
  | "snapshot"
  | "commit"
  | "prove"
  | "pr_review"
  | "function_ref"
  | "pr_opened"
  | "pr_line";

export type RelayPayloadByKind = {
  intent: IntentRelayPayload;
  snapshot: SnapshotRelayPayload;
  commit: CommitRelayPayload;
  prove: ProveRelayPayload;
  pr_review: PrReviewRelayPayload;
  function_ref: FunctionRefRelayPayload;
  pr_opened: PrOpenedRelayPayload;
  pr_line: PrLineRelayPayload;
};

export type RelayCard<K extends RelayKind = RelayKind> = {
  kind: K;
  payload: RelayPayloadByKind[K];
  /** Always 1 for now — bump when the wire shape changes. */
  v: 1;
};

// ─── Wire encode / decode ────────────────────────────────────────────

const SENTINEL_OPEN = "<aura:relay>";
const SENTINEL_CLOSE = "</aura:relay>";

/** Build a one-line preview that gracefully degrades when the sentinel
 *  is stripped. Each kind picks a short human-readable summary. */
function previewLine<K extends RelayKind>(
  kind: K,
  payload: RelayPayloadByKind[K],
): string {
  switch (kind) {
    case "intent": {
      const p = payload as IntentRelayPayload;
      const subj = (p.subject || "").trim();
      const short = subj.length > 80 ? subj.slice(0, 77) + "…" : subj;
      return `[aura-relay] /intent — ${short || "(no subject)"}`;
    }
    case "snapshot": {
      const p = payload as SnapshotRelayPayload;
      return `[aura-relay] /snapshot — ${p.path}`;
    }
    case "commit": {
      const p = payload as CommitRelayPayload;
      const sha = p.sha.slice(0, 7);
      return `[aura-relay] commit ${sha} — ${p.subject}`;
    }
    case "prove": {
      const p = payload as ProveRelayPayload;
      const mark = p.ok ? "✓" : "✗";
      return `[aura-relay] /prove ${mark} — ${p.goal}`;
    }
    case "pr_review": {
      const p = payload as PrReviewRelayPayload;
      const mark = p.verdict === "ok" ? "✓" : p.verdict === "warn" ? "⚠" : "✗";
      const head = p.headline || `vs ${p.base}`;
      return `[aura-relay] /pr-review ${mark} — ${head}`;
    }
    case "function_ref": {
      const p = payload as FunctionRefRelayPayload;
      const where = p.line ? `${p.path}:${p.line}` : p.path;
      return `[aura-relay] fn ${p.name} @ ${where}`;
    }
    case "pr_opened": {
      const p = payload as PrOpenedRelayPayload;
      const subj = (p.title || "").trim();
      const short = subj.length > 80 ? subj.slice(0, 77) + "…" : subj;
      return `[aura-relay] PR #${p.number} opened — ${short || "(untitled)"}`;
    }
    case "pr_line": {
      const p = payload as PrLineRelayPayload;
      const range =
        p.line_start === p.line_end
          ? `${p.line_start}`
          : `${p.line_start}-${p.line_end}`;
      return `[aura-relay] PR #${p.number} ${p.file}:${range}`;
    }
  }
  return "[aura-relay]";
}

/** Encode a relay card into the wire body. Always returns a body with
 *  both a preview line and the sentinel block — the receiver decides
 *  which to render. */
export function encodeRelay<K extends RelayKind>(
  kind: K,
  payload: RelayPayloadByKind[K],
): string {
  const card: RelayCard<K> = { kind, payload, v: 1 };
  const preview = previewLine(kind, payload);
  const sentinel = `${SENTINEL_OPEN}${JSON.stringify(card)}${SENTINEL_CLOSE}`;
  return `${preview}\n${sentinel}`;
}

/** Extract relay cards from a message body. Returns the body with the
 *  sentinel + preview line stripped, plus the parsed cards. Non-card
 *  messages return `{ text: body, cards: [] }`. */
export function parseRelay(body: string): {
  text: string;
  cards: RelayCard[];
} {
  if (!body || typeof body !== "string") {
    return { text: body ?? "", cards: [] };
  }
  const cards: RelayCard[] = [];
  let remaining = body;
  for (;;) {
    const start = remaining.indexOf(SENTINEL_OPEN);
    if (start < 0) break;
    const end = remaining.indexOf(SENTINEL_CLOSE, start + SENTINEL_OPEN.length);
    if (end < 0) break;
    const jsonRaw = remaining.slice(start + SENTINEL_OPEN.length, end);
    try {
      const parsed = JSON.parse(jsonRaw) as RelayCard;
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
        cards.push(parsed);
      }
    } catch {
      /* swallow — keep scanning */
    }
    // Strip the sentinel block AND a trailing preview line we know we
    // emit one above it (`previewLine` always emits a leading `[aura-relay]`).
    const before = remaining.slice(0, start);
    const after = remaining.slice(end + SENTINEL_CLOSE.length);
    // Trim the preview line from the tail of `before` if it's present.
    const previewRe = /\n?\[aura-relay\][^\n]*\n?$/;
    const trimmedBefore = before.replace(previewRe, "");
    remaining = (trimmedBefore + after).trim();
  }
  return { text: remaining, cards };
}

// ─── relay() — fire a structured chat message ────────────────────────

export type RelayTarget = {
  repoRoot: string;
  channel: string;
  /** Optional thread parent — keeps the card inside a reply thread. */
  threadParent?: string;
};

/** Fire a structured payload into a chat channel. Wraps `api.chatSend`
 *  so the caller doesn't have to know about the sentinel. Returns the
 *  resulting `ChatMessage` so callers can flip optimistic UI to
 *  delivered the same way `sendMessage` in CommsPanel does. */
export async function relay<K extends RelayKind>(
  target: RelayTarget,
  kind: K,
  payload: RelayPayloadByKind[K],
): Promise<ChatMessage> {
  const body = encodeRelay(kind, payload);
  return api.chatSend({
    repoRoot: target.repoRoot,
    channel: target.channel,
    body,
    threadParent: target.threadParent,
  });
}

// ─── aura:// URL helpers ─────────────────────────────────────────────
//
// Reference URLs the user can paste into a message and have the channel
// auto-unfurl. Mirrors the GitHub PR/issue/commit unfurl behaviour but
// for Aura-native artifacts. Format:
//
//   aura://intent/<ts>
//   aura://snapshot/<id>            (id may be a path-segment-encoded path)
//   aura://commit/<sha>
//   aura://function/<path>:<name>   (path is URL-encoded if it contains `/`)
//   aura://prove/<goal>             (goal is URL-encoded)
//   aura://pr-review/<base>
//
// Anything else returns null.

export type AuraRef =
  | { kind: "intent"; ts: number }
  | { kind: "snapshot"; id: string }
  | { kind: "commit"; sha: string }
  | { kind: "function"; path: string; name: string }
  | { kind: "prove"; goal: string }
  | { kind: "pr_review"; base: string }
  | { kind: "task"; id: string }
  | { kind: "page"; scope: string; bucket: string; id: string };

const AURA_URL_RE = /^aura:\/\/([a-z_-]+)\/(.+)$/i;

export function parseAuraRef(url: string): AuraRef | null {
  if (!url) return null;
  const m = url.trim().match(AURA_URL_RE);
  if (!m) return null;
  const kindRaw = m[1].toLowerCase();
  const rest = m[2];
  switch (kindRaw) {
    case "intent": {
      const ts = Number(rest);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return { kind: "intent", ts };
    }
    case "snapshot":
      return { kind: "snapshot", id: decodeURIComponent(rest) };
    case "commit": {
      const sha = rest.split(/[?#]/)[0];
      if (!/^[0-9a-f]{4,40}$/i.test(sha)) return null;
      return { kind: "commit", sha };
    }
    case "function": {
      const idx = rest.lastIndexOf(":");
      if (idx < 0) return null;
      const path = decodeURIComponent(rest.slice(0, idx));
      const name = decodeURIComponent(rest.slice(idx + 1));
      if (!path || !name) return null;
      return { kind: "function", path, name };
    }
    case "prove":
      return { kind: "prove", goal: decodeURIComponent(rest) };
    case "pr-review":
    case "pr_review":
      return { kind: "pr_review", base: decodeURIComponent(rest) };
    case "task": {
      const id = decodeURIComponent(rest.split(/[?#]/)[0]);
      if (!id) return null;
      return { kind: "task", id };
    }
    case "page": {
      // aura://page/<scope>/<bucket>/<id>
      const segs = rest
        .split(/[?#]/)[0]
        .split("/")
        .filter(Boolean);
      if (segs.length < 3) return null;
      const scope = decodeURIComponent(segs[0]);
      const bucket = decodeURIComponent(segs[1]);
      const id = decodeURIComponent(segs.slice(2).join("/"));
      if (!scope || !id) return null;
      return { kind: "page", scope, bucket, id };
    }
    default:
      return null;
  }
}

/** Find the first aura:// URL in a body, if it's solo enough that we
 *  want to render the unfurl card (matches `pickSoloLink` semantics
 *  used for HTTP URLs). */
export function pickSoloAuraRef(body: string): string | null {
  if (!body) return null;
  const matches = body.match(/aura:\/\/[a-z_-]+\/[^\s<>"']+/gi);
  if (!matches || matches.length !== 1) return null;
  const url = matches[0];
  const rest = body.replace(url, "").trim();
  if (rest.length > 80) return null;
  return url;
}
