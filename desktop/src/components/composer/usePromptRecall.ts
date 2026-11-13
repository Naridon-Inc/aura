//! Up-arrow recall for a composer that has no conversation of its own yet.
//!
//! The chat composers walk the ring of one conversation. The workspace home
//! sits in front of every conversation — its send is what creates one — so it
//! walks its own ring: the prompts typed there, newest last, under the same
//! `composerDrafts` rules (raw text, consecutive duplicates collapsed, capped).
//! The walk itself matches the chat's, so the two boxes answer the arrow keys
//! the same way: Up at the start of the field steps back (saving what was
//! typed), Down at the end steps forward and, past the newest, restores it.

import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

import { readHistory, rememberSent } from "./composerDrafts";

export function usePromptRecall({
  storageKey,
  value,
  setValue,
  fieldRef,
}: {
  /** Where this box's ring is kept. */
  storageKey: string;
  value: string;
  setValue: (text: string) => void;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
}) {
  // Steps back from the newest while walking; null when not walking.
  const posRef = useRef<number | null>(null);
  // What was in the box when the walk began, for Down past the newest.
  const liveRef = useRef("");

  useEffect(() => {
    posRef.current = null;
    liveRef.current = "";
  }, [storageKey]);

  function place(text: string, at: "start" | "end") {
    setValue(text);
    requestAnimationFrame(() => {
      const el = fieldRef.current;
      if (!el) return;
      const i = at === "start" ? 0 : text.length;
      el.setSelectionRange(i, i);
    });
  }

  function step(dir: "up" | "down"): boolean {
    const ring = readHistory(storageKey);
    if (ring.length === 0) return false;
    const pos = posRef.current;
    if (dir === "up") {
      if (pos === null) {
        liveRef.current = value;
        posRef.current = 0;
      } else if (pos < ring.length - 1) {
        posRef.current = pos + 1;
      } else {
        return true; // already at the oldest
      }
      place(ring[ring.length - 1 - posRef.current], "start");
      return true;
    }
    if (pos === null) return false; // not walking — Down moves the caret
    if (pos > 0) {
      posRef.current = pos - 1;
      place(ring[ring.length - 1 - posRef.current], "end");
    } else {
      posRef.current = null;
      place(liveRef.current, "end");
    }
    return true;
  }

  /** The field's arrow keys. Only a bare Up/Down with the caret at the
   *  field's edge walks; anywhere else the caret moves as usual. */
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.currentTarget;
    const collapsed = el.selectionStart === el.selectionEnd;
    const atEdge =
      e.key === "ArrowUp" ? el.selectionStart === 0 : el.selectionEnd === el.value.length;
    if (collapsed && atEdge && step(e.key === "ArrowUp" ? "up" : "down")) e.preventDefault();
  }

  /** A prompt went out: keep it, and leave any walk in progress. */
  function remember(text: string) {
    rememberSent(storageKey, text);
    posRef.current = null;
    liveRef.current = "";
  }

  return { onKeyDown, remember };
}
