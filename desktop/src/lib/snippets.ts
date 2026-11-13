// Saved prompt snippets: a name, an optional keyword typed after ";" in the
// composer, and the text it inserts. They live on this computer only, under
// one durable key, and every window sees a change as soon as it is written.

import { useSyncExternalStore } from "react";
import { setDurable } from "./localStore";

export interface Snippet {
  id: string;
  name: string;
  /** Typed after ";" to find or insert the snippet. No spaces, no ";". */
  keyword: string | null;
  body: string;
  createdAt: number;
}

export const SNIPPET_NAME_MAX = 100;
export const SNIPPET_BODY_MAX = 10_000;
export const SNIPPET_KEYWORD_MAX = 32;
/** The character that opens the snippet list in the composer. */
export const SNIPPET_CHAR = ";";

const KEY = "aura.snippets.v1";
const listeners = new Set<() => void>();
let cached: Snippet[] | null = null;

function isSnippet(value: unknown): value is Snippet {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.body === "string" &&
    (s.keyword === null || typeof s.keyword === "string") &&
    typeof s.createdAt === "number"
  );
}

/** What is stored, oldest first; anything unreadable reads as no snippets. */
export function parseSnippets(raw: string | null): Snippet[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSnippet) : [];
  } catch {
    return [];
  }
}

function read(): Snippet[] {
  if (cached) return cached;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  cached = parseSnippets(raw);
  return cached;
}

function emit() {
  for (const listener of listeners) listener();
}

export function listSnippets(): Snippet[] {
  return read();
}

/** A keyword as the field keeps it: no spaces or ";", at most 32 letters. */
export function cleanKeyword(raw: string): string {
  return raw.replace(/[\s;]/g, "").slice(0, SNIPPET_KEYWORD_MAX);
}

export type SnippetDraft = { name: string; body: string; keyword: string };

/** Whether a draft can be saved as it stands. */
export function snippetDraftValid(draft: SnippetDraft): boolean {
  const name = draft.name.trim();
  const body = draft.body.trim();
  return (
    name.length > 0 &&
    body.length > 0 &&
    name.length <= SNIPPET_NAME_MAX &&
    body.length <= SNIPPET_BODY_MAX
  );
}

/** Saves a new snippet. Returns it, or null when the draft is incomplete or
 *  the computer refused the write. */
export function createSnippet(draft: SnippetDraft, now = Date.now()): Snippet | null {
  if (!snippetDraftValid(draft)) return null;
  const keyword = cleanKeyword(draft.keyword);
  const snippet: Snippet = {
    id: `snippet-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: draft.name.trim(),
    body: draft.body.trim(),
    keyword: keyword || null,
    createdAt: now,
  };
  const next = [...read(), snippet];
  if (!setDurable(KEY, JSON.stringify(next))) return null;
  cached = next;
  emit();
  return snippet;
}

// Another window's write reaches this one through the storage event, heard
// while anything here is listening.
function onStorage(event: StorageEvent) {
  if (event.key !== KEY) return;
  cached = parseSnippets(event.newValue);
  emit();
}

export function subscribeSnippets(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || typeof window === "undefined") return;
    window.removeEventListener("storage", onStorage);
    // Nothing hears other windows now, so the next read goes to storage.
    cached = null;
  };
}

export function useSnippets(): Snippet[] {
  return useSyncExternalStore(subscribeSnippets, read, read);
}

/** Where ";" goes when the snippet list is asked for from the caret: right
 *  there, after a space unless the caret already follows one (or starts the
 *  field). */
export function insertSnippetChar(
  value: string,
  caret: number,
): { value: string; caret: number } {
  const before = value.slice(0, caret);
  const text = before === "" || /\s$/.test(before) ? SNIPPET_CHAR : ` ${SNIPPET_CHAR}`;
  return { value: before + text + value.slice(caret), caret: caret + text.length };
}
