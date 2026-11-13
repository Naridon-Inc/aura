import type { QueuedMessage } from "../ManagerQueueStack";

// ── W2 type-ahead queue persistence ───────────────────────────────────
// The pending queue is scoped per Manager session so a reload keeps it.
const QUEUE_KEY = (sid: string) => `aura.manager.queue.${sid}`;

export function loadQueue(sid: string): QueuedMessage[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY(sid));
    if (!raw) return [];
    const arr = JSON.parse(raw) as Partial<QueuedMessage>[];
    if (!Array.isArray(arr)) return [];
    // Persisted entries never carry attachments (stripped on save — base64
    // blobs are megabyte-scale and don't survive a reload). Rehydrate as
    // text-only queued turns.
    return arr
      .filter((m) => typeof m?.text === "string")
      .map((m, i) => ({
        id: typeof m.id === "string" ? m.id : `q${i}`,
        text: m.text as string,
        attachments: [],
        mode: (m.mode as QueuedMessage["mode"]) ?? "build",
        pipeTargetSessionId: m.pipeTargetSessionId ?? null,
        effort: m.effort ?? null,
        fast: !!m.fast,
        approval: (m.approval as QueuedMessage["approval"]) ?? null,
        goal: !!m.goal,
      }));
  } catch {
    return [];
  }
}

export function saveQueue(sid: string, queue: QueuedMessage[]): void {
  try {
    // Strip attachments before persisting — keep only the lightweight,
    // serializable run payload.
    const lite = queue.map((m) => ({
      id: m.id,
      text: m.text,
      mode: m.mode,
      pipeTargetSessionId: m.pipeTargetSessionId,
      effort: m.effort,
      fast: m.fast,
      approval: m.approval,
    }));
    if (lite.length === 0) localStorage.removeItem(QUEUE_KEY(sid));
    else localStorage.setItem(QUEUE_KEY(sid), JSON.stringify(lite));
  } catch {
    /* storage disabled / quota exceeded */
  }
}

export function newQueueId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to timestamp id */
  }
  return `q-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}
