// The chat attachment wire format. The composer appends a sentinel to
// whatever the user typed:
//
//     <user's text>
//     <aura:attachments>[{"url":"…","filename":"…","mime":"…","size":…}]</aura:attachments>
//
// `parseAttachments(body)` returns `{text, attachments}`; `encodeAttachments`
// is its inverse.

export type ChatAttachment = {
  url: string;
  filename: string;
  mime: string;
  size: number;
  /** Optional — present on uploads returned by the cloud upload endpoint. */
  sha256?: string;
  /** Rich metadata added by the in-composer recorder. Older audio uploads
   *  omit it and still receive the same custom player. */
  kind?: "voice-note";
  duration?: number;
  transcript?: string;
};

const SENTINEL_OPEN = "<aura:attachments>";
const SENTINEL_CLOSE = "</aura:attachments>";

/** Strip the `<aura:attachments>` sentinel from a message body and
 *  return the plain text plus the parsed attachment list. Malformed
 *  payloads are silently dropped; the surrounding text is preserved. */
export function parseAttachments(body: string): {
  text: string;
  attachments: ChatAttachment[];
} {
  if (!body || typeof body !== "string") {
    return { text: body ?? "", attachments: [] };
  }
  const start = body.indexOf(SENTINEL_OPEN);
  if (start < 0) return { text: body, attachments: [] };
  const end = body.indexOf(SENTINEL_CLOSE, start + SENTINEL_OPEN.length);
  if (end < 0) return { text: body, attachments: [] };

  const jsonRaw = body.slice(start + SENTINEL_OPEN.length, end);
  const before = body.slice(0, start).replace(/\s+$/, "");
  const after = body.slice(end + SENTINEL_CLOSE.length).replace(/^\s+/, "");
  const text = [before, after].filter(Boolean).join("\n").trim();

  let attachments: ChatAttachment[] = [];
  try {
    const parsed = JSON.parse(jsonRaw);
    if (Array.isArray(parsed)) {
      attachments = parsed
        .filter(
          (a): a is Record<string, unknown> =>
            !!a && typeof a === "object" && typeof (a as Record<string, unknown>).url === "string",
        )
        .map((a) => ({
          url: String(a.url ?? ""),
          filename:
            typeof a.filename === "string" && a.filename ? a.filename : "file",
          mime:
            typeof a.mime === "string" && a.mime
              ? a.mime
              : "application/octet-stream",
          size: typeof a.size === "number" && a.size >= 0 ? a.size : 0,
          sha256: typeof a.sha256 === "string" ? a.sha256 : undefined,
          kind: a.kind === "voice-note" ? "voice-note" : undefined,
          duration: typeof a.duration === "number" ? a.duration : undefined,
          transcript: typeof a.transcript === "string" ? a.transcript : undefined,
        }));
    }
  } catch {
    // fall through — empty attachments, text preserved
  }
  return { text, attachments };
}

/** Encode an attachment list into the trailing sentinel form. A no-op
 *  when the list is empty so callers can wrap their send path
 *  unconditionally. */
export function encodeAttachments(
  text: string,
  attachments: ChatAttachment[],
): string {
  const trimmed = (text ?? "").replace(/\s+$/, "");
  if (!attachments || attachments.length === 0) return trimmed;
  const payload = attachments.map((a) => ({
    url: a.url,
    filename: a.filename,
    mime: a.mime,
    size: a.size,
    ...(a.sha256 ? { sha256: a.sha256 } : {}),
    ...(a.kind ? { kind: a.kind } : {}),
    ...(typeof a.duration === "number" ? { duration: a.duration } : {}),
    ...(a.transcript ? { transcript: a.transcript } : {}),
  }));
  const sentinel = `${SENTINEL_OPEN}${JSON.stringify(payload)}${SENTINEL_CLOSE}`;
  return trimmed ? `${trimmed}\n${sentinel}` : sentinel;
}
