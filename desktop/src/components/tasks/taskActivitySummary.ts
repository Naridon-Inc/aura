// One activity event in words, for the task's Activity timeline. Unknown
// kinds fall back to the raw kind so a newer event still says something.

import type { TaskActivity } from "../../lib/api";

export function summariseActivity(ev: TaskActivity): string {
  const payload = ev.payload ?? {};
  switch (ev.kind) {
    case "created":
      return "created this task";
    case "updated":
      return (payload as { deleted?: boolean }).deleted
        ? "deleted this task"
        : "updated this task";
    case "state_changed": {
      const from = (payload as { from?: string }).from;
      const to = (payload as { to?: string }).to;
      return from && to
        ? `changed state from ${from} → ${to}`
        : "changed state";
    }
    case "assigned": {
      const added = (payload as { added?: string[] }).added ?? [];
      return added.length > 0
        ? `assigned ${added.join(", ")}`
        : "assigned this task";
    }
    case "unassigned": {
      const removed = (payload as { removed?: string[] }).removed ?? [];
      return removed.length > 0
        ? `removed ${removed.join(", ")}`
        : "unassigned this task";
    }
    case "labeled": {
      const added = (payload as { added?: string[] }).added ?? [];
      return added.length > 0
        ? `added label${added.length > 1 ? "s" : ""} ${added.join(", ")}`
        : "added a label";
    }
    case "unlabeled": {
      const removed = (payload as { removed?: string[] }).removed ?? [];
      return removed.length > 0
        ? `removed label${removed.length > 1 ? "s" : ""} ${removed.join(", ")}`
        : "removed a label";
    }
    case "linked": {
      const target = (payload as { target_id?: string }).target_id;
      const kind = (payload as { kind?: string }).kind;
      return `linked ${target ?? ""} (${kind ?? "relation"})`;
    }
    case "unlinked": {
      const target = (payload as { target_id?: string }).target_id;
      return `unlinked ${target ?? "a relation"}`;
    }
    case "commented":
      return "commented";
    default:
      return ev.kind;
  }
}
