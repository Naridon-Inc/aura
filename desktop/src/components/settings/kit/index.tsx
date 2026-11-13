// ── Settings kit ──────────────────────────────────────────────────────
//
// The vocabulary every settings page is built from, drawn with the shared
// settings rows, selects, switches and tables. Split by job:
//
//   rows      — a page's skeleton: intro, sections, the setting row
//   controls  — the right-hand side: switches, selects, numbers, badges
//   blocks    — what a row can't carry: a table of facts, a live status

export { Card, Field, PaneIntro, Row, Section, Toggle } from "./rows";
export { CheckboxLabel, ChoiceSelect, SelectField, StatusPill, Stepper } from "./controls";
export { ConnectionStatus, KeyValueTable, type KeyValueRow } from "./blocks";
