// Window events for the composer chords that the keymap cannot answer itself.
//
// `resolveShortcut` is a pure table and `useAppActions` is mounted once at the
// top of the app, but the controls these keys drive live inside whichever
// composer is on screen. The dispatcher therefore fires an event and the
// composer answers — the same shape `effortCycle`'s ⌘⇧/ already uses.
//
// Who answers differs by what the key changes, and that difference is the
// point:
//
//   * Fast is one persisted value shared by every composer, so every mounted
//     composer updates its own chip. They have to agree.
//   * A loadout slot picks the model for the NEXT TURN OF ONE SESSION. If
//     every mounted picker answered, one keypress would change the model of a
//     chat the user is not looking at. So the picker only answers when the
//     composer it sits in holds the focus.

/** ⌘⇧E — flip the latency switch. */
export const TOGGLE_FAST_EVENT = "aura:composer:toggle-fast";

/** ⌘1…⌘5 — pick that slot of the model loadout. */
export const PICK_MODEL_SLOT_EVENT = "aura:composer:pick-model-slot";

export type PickModelSlotDetail = { slot: number };

export function pickModelSlotEvent(slot: number): CustomEvent<PickModelSlotDetail> {
  return new CustomEvent<PickModelSlotDetail>(PICK_MODEL_SLOT_EVENT, {
    detail: { slot },
  });
}

/** The slot a `pick_model_<n>` action id names, or null for anything else.
 *  Keeps the digit in one place instead of a switch at the dispatcher. */
export function modelSlotFromActionId(id: string): number | null {
  const m = /^pick_model_([1-9])$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** What to CALL the composer's modifier key on screen.
 *
 *  Every chord in here is handled as `metaKey || ctrlKey`, so the key that
 *  works is ⌘ on a Mac and Ctrl everywhere else. The composer now prints one
 *  of these chords in its own corner ("⌘L to focus"), and a hint that names
 *  the wrong key is worse than no hint — it teaches a keystroke that does
 *  nothing on that machine.
 *
 *  Pure and parameterised so it can be asserted without a browser; the
 *  no-argument form reads the real navigator. Unknown platform falls to
 *  "Ctrl" rather than ⌘, because ⌘ is the narrower claim: it only exists on
 *  Apple hardware, while Ctrl is on every keyboard including Apple's. */
export function modKeyLabel(platform?: string, userAgent?: string): string {
  const p = platform ?? (typeof navigator === "undefined" ? "" : navigator.platform || "");
  const ua = userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent || "");
  return /Mac|iPhone|iPad|iPod/i.test(p) || /Macintosh/i.test(ua) ? "⌘" : "Ctrl+";
}
