// ── Settings kit ──────────────────────────────────────────────────────
//
// The shared vocabulary every settings pane is built from. One barrel so
// the twenty-odd panes keep importing `../settings/kit` while the kit
// itself stays split by job:
//
//   rows      — the page's skeleton: header, sections, the setting row
//   controls  — the right-hand side: switches, selects, steppers, pills
//   blocks    — what a row can't carry: a table of facts, a live status
//
// Adding a primitive means adding it to one of those three and exporting
// it here; nothing downstream changes.

export { Card, Field, PaneHeader, PaneIntro, Row, Section, Toggle } from "./rows";
export { CheckboxLabel, SegControl, SelectField, StatusPill, Stepper } from "./controls";
export { ConnectionStatus, KeyValueTable, type KeyValueRow } from "./blocks";
