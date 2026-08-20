//! Tool-naming helpers every adapter shares.
//!
//! Each engine calls the same underlying act by a different name — Claude runs
//! `Bash`, Codex runs `exec`, ACP engines run `shell` — but the card the human
//! reads should say "Running" in all three. `describeTool` is the one registry
//! that decides that, so the adapters route through here rather than each
//! keeping its own copy of the mapping. Two copies would drift, and the drift
//! would show up as the same tool wearing a different glyph depending on which
//! CLI you happened to be talking to.

import { describeTool } from "../../../components/manager/chat/toolDescribe";
import type { ToolGlyph, ToolResult } from "../../../components/manager/chat/types";
import type { ToolKind } from "../events";

/** ACP-ish glyph → ToolKind. `toolDescribe` already normalizes per-brain
 *  naming into a glyph; we re-use that instead of re-deriving the kind. */
export const GLYPH_TO_KIND: Record<ToolGlyph, ToolKind> = {
  read: "read",
  search: "search",
  glob: "search",
  list: "read",
  fetch: "fetch",
  edit: "edit",
  write: "edit",
  run: "execute",
  dispatch: "other",
  ask: "other",
  task: "todo",
  page: "other",
  review: "other",
  plan: "plan",
  generic: "other",
};

export function asObj(input: unknown): Record<string, unknown> {
  return input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};
}

export function norm(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

/** Build a humanized one-line title from the tool-describe registry so the
 *  card headline reads "Editing foo.ts", never `str_replace`. */
export function titleFor(
  name: string,
  input: unknown,
  result?: ToolResult,
): string {
  const v = describeTool(name, input, result);
  return v.subject ? `${v.verb} ${v.subject}` : v.verb;
}

export function kindFor(name: string, input: unknown): ToolKind {
  const v = describeTool(name, input);
  return GLYPH_TO_KIND[v.glyph ?? "generic"] ?? "other";
}
