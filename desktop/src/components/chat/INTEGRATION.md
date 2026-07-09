# Wiring `FileUploadButton` + `FileAttachment` into chat

Phase 5 of the chat overhaul: file uploads.

All four touch-points below are tiny — every component / command works
on its own, this just hooks them into the existing surfaces.

---

## 1. `aura-shell/src-tauri/src/lib.rs` — register the new module + command

Near the other `mod cmd_…` lines (≈line 50):

```rust
mod cmd_team_upload;
```

Inside the `tauri::generate_handler![ … ]` macro, alongside
`cmd_team::chat_send`:

```rust
cmd_team_upload::chat_upload_attachment,
```

That's it for Rust wiring — no AppState, no plugins, no migrations.

---

## 2. `aura-shell/src/lib/api.ts` — typed wrapper for the new command

Near the other `chat…` wrappers (≈line 785), add:

```ts
chatUploadAttachment: (repoRoot: string, filePath: string) =>
  invoke<{
    url: string;
    sha256: string;
    size: number;
    mime: string;
    filename: string;
  }>("chat_upload_attachment", { repoRoot, filePath }),
```

After this lands, you can optionally swap the local `invoke()` call
inside `FileUploadButton.tsx` for `api.chatUploadAttachment(…)` — both
behave identically. Leaving the local wrapper is fine; it's just three
lines of duplication.

---

## 3. `aura-shell/src/components/CommsPanel.tsx` — composer + render

Imports (near the other component imports at the top):

```tsx
import { FileUploadButton } from "./chat/FileUploadButton";
import {
  FileAttachment,
  parseAttachments,
  encodeAttachments,
  type ChatAttachment,
} from "./chat/FileAttachment";
```

State (alongside the other composer `useState`s):

```tsx
const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
const composerRef = useRef<HTMLDivElement>(null);
```

Put the paperclip in the composer toolbar (same row as the send button
/ mention button). Pass `composerRef` so drops anywhere on the composer
area trigger the upload:

```tsx
<FileUploadButton
  repoRoot={repoRoot}
  dropTargetRef={composerRef}
  onUploaded={(a) => setPendingAttachments((xs) => [...xs, a])}
  onError={(msg) => /* existing toast helper */ }
/>
```

Wrap the composer area with the ref + render the staged attachments
above the textarea (each one is removable via the upload chip's × that
the button manages itself; for staged-but-pre-send removal use the
optional renderer below):

```tsx
<div ref={composerRef}>
  {pendingAttachments.length > 0 && (
    <div className="flex flex-wrap gap-1.5 px-2 pt-2">
      {pendingAttachments.map((a, i) => (
        <div
          key={`${a.sha256 ?? a.url}:${i}`}
          className="h-7 px-2 rounded-md bg-bg-2 border border-line-soft text-text-2 text-[11.5px] flex items-center gap-1.5"
        >
          <span className="max-w-[140px] truncate">{a.filename}</span>
          <button
            type="button"
            onClick={() =>
              setPendingAttachments((xs) => xs.filter((_, j) => j !== i))
            }
            className="text-text-4 hover:text-text-1"
            title="Remove"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )}
  {/* existing textarea + send button */}
</div>
```

Encode-on-send — wrap the user's body right before the existing
`api.chatSend(…)` call:

```tsx
const body = encodeAttachments(text.trim(), pendingAttachments);
await api.chatSend({ repoRoot, channel, body, /* …other args */ });
setPendingAttachments([]);
```

`encodeAttachments` is a no-op when the list is empty, so it's safe to
call unconditionally.

Render incoming attachments — replace the direct `msg.body` render with
the parsed view (works alongside the existing `parseRepoFiles` chain;
just parse both):

```tsx
{messages.map((msg) => {
  const { text, attachments } = parseAttachments(msg.body);
  return (
    <div key={msg.id}>
      {/* existing avatar / header */}
      {text && <div className="…existing body classes…">{text}</div>}
      {attachments.length > 0 && (
        <div className="flex flex-col gap-1.5 mt-1.5">
          {attachments.map((a, i) => (
            <FileAttachment key={`${msg.id}:${i}`} attachment={a} />
          ))}
        </div>
      )}
    </div>
  );
})}
```

If you're already chaining `parseRepoFiles(msg.body)`, run
`parseAttachments` on the `.text` that comes back — both sentinels
coexist cleanly because each ignores the other's tags.

---

## 4. Cloud (already deployed by this PR — no action needed)

For reference, the cloud now exposes:

- `POST /api/v1/room/{room_id}/upload` (multipart: `file`, `filename`,
  `device_id`; 25 MB cap; returns `{url, sha256, size, mime}`)
- `GET /api/v1/room/{room_id}/u/{sha256}.{ext}` (serves the file with
  the stored MIME)

Storage path on the server: `/var/aura/uploads/<room_id>/<sha256>.<ext>`
(override with `AURA_UPLOADS_ROOT` env var; e.g. tests set it to a
tempdir). Same trust model as `rooms.rs`: anyone with the clone can
read or write — no auth.
