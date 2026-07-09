// Re-export shim — canonical location is now `components/ui/ascii-spinner`.
// Kept around so call sites in `components/manager/` (currently mid-merge
// and off-limits to refactor) keep working. Safe to delete once those
// imports are updated.

export { AsciiSpinner } from "./ui/ascii-spinner";
