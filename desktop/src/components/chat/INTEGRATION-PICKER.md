# Wiring `RepoFilePicker` + `RepoFileChip` into `CommsPanel`

Three drop-in patches. None of them touch Rust/Tauri or `lib/api.ts`.

---

## 1. CommsPanel.tsx — imports

Add near the other component imports at the top of `CommsPanel.tsx`:

```tsx
import { FileCode } from "lucide-react";
import { RepoFilePicker } from "./chat/RepoFilePicker";
import { RepoFileChip, parseRepoFiles, encodeRepoFiles } from "./chat/RepoFileChip";
```

## 2. CommsPanel.tsx — state hook

Inside the `CommsPanel` component body (near the other `useState` calls):

```tsx
const [pickerOpen, setPickerOpen] = useState(false);
const [pendingAttachments, setPendingAttachments] = useState<
  { path: string; lineStart?: number; lineEnd?: number }[]
>([]);
```

## 3. CommsPanel.tsx — composer toolbar button

In the composer toolbar (the row with the send button / mention button),
add this trigger. The icon matches the rest of the toolbar at 14px.

```tsx
<button
  type="button"
  onClick={() => setPickerOpen(true)}
  className="text-text-3 hover:text-text-1 p-1 rounded hover:bg-bg-hover"
  title="Attach repo file"
  aria-label="Attach repo file"
>
  <FileCode size={14} />
</button>
```

Optional: render the pending-attachment chips above the textarea so the
user sees what they're about to send:

```tsx
{pendingAttachments.length > 0 && (
  <div className="flex flex-wrap gap-1.5 px-2 pt-2">
    {pendingAttachments.map((a) => (
      <RepoFileChip
        key={`${a.path}:${a.lineStart ?? ""}`}
        repoRoot={repoRoot}
        path={a.path}
        lineStart={a.lineStart}
        lineEnd={a.lineEnd}
        onRemove={() =>
          setPendingAttachments((xs) => xs.filter((x) => x.path !== a.path))
        }
      />
    ))}
  </div>
)}
```

## 4. CommsPanel.tsx — picker element

Render anywhere in the component's JSX (typical: just before the closing
tag of the panel root, so the overlay sits above everything):

```tsx
<RepoFilePicker
  open={pickerOpen}
  repoRoot={repoRoot}
  onClose={() => setPickerOpen(false)}
  onPick={(path) =>
    setPendingAttachments((xs) =>
      xs.some((x) => x.path === path) ? xs : [...xs, { path }],
    )
  }
/>
```

## 5. CommsPanel.tsx — encode on send

Right before the existing `api.commsSend` (or equivalent) call, wrap the
user's text body so the attachments ride along on the wire:

```tsx
const body = encodeRepoFiles(text.trim(), pendingAttachments);
await api.commsSend(repoRoot, body, /* ...other args... */);
setPendingAttachments([]);
```

`encodeRepoFiles` is a no-op when `pendingAttachments` is empty, so this
is safe to call unconditionally.

## 6. CommsPanel.tsx — render received attachments

Wherever each message is rendered (`messages.map(msg => …)`), replace the
direct body render with the parsed view:

```tsx
{messages.map((msg) => {
  const { text, files } = parseRepoFiles(msg.body);
  return (
    <div key={msg.id} className="…existing classes…">
      {/* existing avatar / header / etc. */}
      {text && <div className="…body classes…">{text}</div>}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {files.map((f, i) => (
            <RepoFileChip
              key={`${msg.id}:${i}`}
              repoRoot={repoRoot}
              path={f.path}
              lineStart={f.lineStart}
              lineEnd={f.lineEnd}
            />
          ))}
        </div>
      )}
    </div>
  );
})}
```

---

## 7. App.tsx — register the `aura:open-file` listener

`RepoFileChip` dispatches a `CustomEvent("aura:open-file", { detail: { path, line } })`
when clicked. The codebase already dispatches this event from
`SemanticGraphPane.tsx` but no global listener exists yet, so the chips
will be inert until you add one. Inside `App.tsx`, alongside the other
`useEffect`s that bind window events, add:

```tsx
useEffect(() => {
  function onOpenFile(e: Event) {
    const detail = (e as CustomEvent<{ path: string; line?: number }>).detail;
    if (!detail?.path) return;
    void openFileImperative(detail.path).then(() => {
      if (detail.line && detail.line > 0) {
        // The Monaco wrapper already listens for this event.
        window.dispatchEvent(
          new CustomEvent("aura:scroll-to-line", {
            detail: { path: detail.path, line: detail.line },
          }),
        );
      }
    });
  }
  window.addEventListener("aura:open-file", onOpenFile);
  return () => window.removeEventListener("aura:open-file", onOpenFile);
}, []);
```

`openFileImperative` is already exported from `../lib/editorStore` and is
used elsewhere in `App.tsx`. `aura:scroll-to-line` is already listened to
by `MonacoEditor.tsx`, so no further wiring is needed for line-jumps.

---

## Summary of files touched

- `CommsPanel.tsx` — imports, two `useState`s, one toolbar button, one
  `<RepoFilePicker>` element, one `encodeRepoFiles` call on send, one
  `parseRepoFiles` call in the message render loop.
- `App.tsx` — one `useEffect` registering the `aura:open-file` listener.

Nothing else — no Rust, no `api.ts` changes, no schema changes.
