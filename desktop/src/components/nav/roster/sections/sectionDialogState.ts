// Which section dialog is up, if any. Several places open it (the list's
// heading, a section's menu, a row's "Move to section"), and one dialog drawn
// by the list answers them all.

import { useSyncExternalStore } from "react";

export type SectionDialogRequest =
  /** Make a section: before `before` when named, and with the workspace at
   *  `movePath` (or the repository `moveRepo`) put straight into it when one
   *  asked. */
  | { mode: "new"; before?: string; movePath?: string; moveRepo?: string }
  | { mode: "edit"; id: string };

let request: SectionDialogRequest | null = null;
const listeners = new Set<() => void>();

const announce = () => {
  for (const listener of listeners) listener();
};

/** Next frame, so a menu that asked has closed and handed focus back before
 *  the dialog takes it. */
export function openSectionDialog(next: SectionDialogRequest): void {
  requestAnimationFrame(() => {
    request = next;
    announce();
  });
}

export function closeSectionDialog(): void {
  request = null;
  announce();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useSectionDialogRequest(): SectionDialogRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => request,
    () => null,
  );
}
