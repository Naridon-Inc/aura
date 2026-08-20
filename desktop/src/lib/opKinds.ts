// What Aura did, in words, and which of it can be taken back.
//
// The undo list used to be drawn straight from the engine: rows tagged
// `intent_attribute`, a button reading "Undo: guard_revert". Worse than the
// vocabulary, the button was offered on steps that have no inverse. The list
// carries eight kinds and `apply_undo` (src-tauri/src/op_log.rs:147-155)
// implements six, three of which are not the same six — press Undo on a
// resolved conflict and the engine answers "no inverse implemented for op kind
// 'conflict_resolve'", which is then printed at you verbatim.
//
// So both halves live here, next to each other, and tests/opLog.test.ts reads
// op_log.rs and the `record_op` call sites to check that this file still agrees
// with them. Add a kind in Rust and the suite tells you it has no name here;
// implement an inverse and the suite tells you the button still won't offer it.

/** Every op kind the engine writes, in plain words. */
export const OP_KIND_LABEL: Record<string, string> = {
  snapshot: "Backed up a file",
  log_intent: "Wrote down a reason",
  intent_attribute: "Linked files to a reason",
  intent_split: "Split one reason into two",
  intent_merge: "Merged two reasons into one",
  conflict_open: "Flagged a clash",
  conflict_resolve: "Settled a clash",
  guard_revert: "Put a file back",
  zone_claim: "Claimed an area of the project",
};

/**
 * The kinds `apply_undo` can actually reverse — one arm of its match, in the
 * same order. Anything else is history you can read and not history you can
 * take back, and the surface has to say so before you press rather than after.
 */
export const UNDOABLE_OP_KINDS: readonly string[] = [
  "log_intent",
  "snapshot",
  "intent_attribute",
  "intent_split",
  "intent_merge",
  "zone_claim",
];

export function opKindLabel(kind: string): string {
  // An unknown kind is a kind this file hasn't caught up with yet. Show the raw
  // tag rather than "Unknown step" — it's ugly, but it names the thing, and the
  // test that guards this will have failed in CI before it ever gets here.
  return OP_KIND_LABEL[kind] ?? kind;
}

export function isUndoable(kind: string): boolean {
  return UNDOABLE_OP_KINDS.includes(kind);
}
