// "Change icon" hands off to the operating system's own emoji picker rather
// than a curated grid. The repository the pick is for is remembered across the
// menu closing and the picker's round trip; the chosen glyph arrives in a
// hidden input the list keeps mounted, so focus lands at once.

import { useRef, type CSSProperties, type FormEvent, type RefObject } from "react";
import { api } from "../../../lib/api";
import { firstGrapheme } from "../../../lib/graphemes";
import { setWorkspaceEmoji } from "../../../lib/workspaceCustomization";

const OFF_SCREEN: CSSProperties = {
  position: "fixed",
  top: -9999,
  left: -9999,
  width: 1,
  height: 1,
  opacity: 0,
  pointerEvents: "none",
};

export type EmojiCaptureProps = {
  ref: RefObject<HTMLInputElement | null>;
  onInput: (e: FormEvent<HTMLInputElement>) => void;
  "aria-hidden": true;
  tabIndex: -1;
  inputMode: "none";
  autoComplete: "off";
  style: CSSProperties;
};

export function useEmojiPick(): {
  pickIcon: (id: string) => void;
  captureProps: EmojiCaptureProps;
} {
  const targetRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the capture input, then front the system picker so the glyph the
  // user picks is inserted into it. Off macOS the Rust side is a no-op and the
  // user's own OS shortcut still lands in the focused input.
  const pickIcon = (id: string) => {
    targetRef.current = id;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.value = "";
        el.focus();
      }
      void api.openSystemEmojiPicker().catch(() => {
        /* picker unavailable: the capture input is focused for the OS shortcut */
      });
    });
  };

  const onInput = (e: FormEvent<HTMLInputElement>) => {
    const raw = e.currentTarget.value;
    const target = targetRef.current;
    e.currentTarget.value = "";
    targetRef.current = null;
    e.currentTarget.blur();
    if (!raw || !target) return;
    const glyph = firstGrapheme(raw);
    if (glyph) setWorkspaceEmoji(target, glyph);
  };

  return {
    pickIcon,
    captureProps: {
      ref: inputRef,
      onInput,
      "aria-hidden": true,
      tabIndex: -1,
      inputMode: "none",
      autoComplete: "off",
      style: OFF_SCREEN,
    },
  };
}
