// Clipboard write with a textarea/execCommand fallback for the rare
// browser environments that disallow `navigator.clipboard.writeText`
// (older webview shells, sandboxed iframes). Lifted from superset.sh's
// apps/desktop/src/renderer/hooks/useCopyToClipboard.ts. The hook
// exposes a `copied` flag that flips back after `timeout` ms so a
// "Copied!" badge can flash without extra state plumbing.

import { useCallback, useState } from "react";

async function writeTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through to the textarea fallback below */
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);

  // Preserve any existing user selection — the temporary textarea
  // would otherwise blow it away.
  const sel = document.getSelection();
  const prevRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("copy failed");
  } finally {
    document.body.removeChild(textarea);
    if (prevRange && sel) {
      sel.removeAllRanges();
      sel.addRange(prevRange);
    }
  }
}

export function useCopyToClipboard(timeoutMs = 2000) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    async (text: string) => {
      await writeTextToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), timeoutMs);
    },
    [timeoutMs],
  );
  return { copy, copied };
}
