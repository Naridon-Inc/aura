// An engine we drive as a plain CLI writes its answer to stdout, and the
// brain passes stdout through as the turn's text. When the engine fails it
// writes its error event to the same place, so the turn's text is a line of
// JSON — `{"type":"error",…,"error":{"name":"UnknownError","data":{"message":
// "Failed to get direct access token: 401 Unauthorized"}}}` from OpenCode —
// and that JSON is not something to show anyone.
//
// This recognises such a paragraph and says what happened in plain words.
// Only a paragraph that is one whole JSON error event qualifies: prose that
// mentions an error, or a JSON example inside an answer, is left alone.

export type EngineErrorEvent = {
  /** HTTP status the engine reported, when it gave one. */
  status: number | null;
  /** What went wrong, in a few plain words ("couldn't sign in"). */
  reason: string;
  /** The engine's own message, for a tooltip. Never shown as the row. */
  detail: string;
};

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function httpStatus(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{3}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : null;
}

/** The engine's message out of whichever shape its error took. */
function messageOf(err: unknown): string {
  if (typeof err === "string") return err.trim();
  const o = asObj(err);
  if (!o) return "";
  const data = asObj(o.data);
  return str(data?.message) ?? str(o.message) ?? str(o.name) ?? "";
}

function statusOf(err: unknown, message: string): number | null {
  const o = asObj(err);
  const data = asObj(o?.data);
  return (
    httpStatus(o?.status) ??
    httpStatus(o?.code) ??
    httpStatus(data?.statusCode) ??
    httpStatus(data?.status) ??
    httpStatus(/\b([45]\d\d)\b/.exec(message)?.[1])
  );
}

function reasonFor(status: number | null, message: string): string {
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|access token|api key/i.test(message)) {
    return "couldn't sign in";
  }
  if (status === 429 || /rate.?limit|quota/i.test(message)) return "hit its usage limit";
  if (status != null && status >= 500) return "couldn't reach its service";
  return "stopped with an error";
}

/** The error event this paragraph is, or null when it is anything else. */
export function parseEngineErrorEvent(paragraph: string): EngineErrorEvent | null {
  const text = paragraph.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const o = asObj(parsed);
  if (!o) return null;
  let err: unknown;
  if (o.type === "error") {
    // OpenCode's run wire: `{ type: "error", timestamp, sessionID, error }`.
    err = o.error ?? o.message;
  } else if (asObj(o.error) && Object.keys(o).every((k) => k === "error")) {
    // A bare API error body, `{ "error": { code, message, status } }`.
    err = o.error;
  } else {
    return null;
  }
  const detail = messageOf(err);
  const status = statusOf(err, detail);
  return { status, reason: reasonFor(status, detail), detail };
}

/** The row's words: "OpenCode couldn't sign in (401)". */
export function engineErrorSentence(event: EngineErrorEvent, engine?: string | null): string {
  const who = engine?.trim() || "The engine";
  return `${who} ${event.reason}${event.status != null ? ` (${event.status})` : ""}`;
}
