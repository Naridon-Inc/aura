// An open file whose copy on disk changed while it had unsaved edits.
//
// The tab holds two texts: `baseline`, the last thing read from disk, and
// `current`, what is in the editor. Edits are unsaved while they differ.
// When the file changes on disk under unsaved edits, the edits stay and the
// tab is marked: saving is held until the person says which copy wins —
// keep theirs (the next save overwrites the new copy) or discard them (the
// editor shows the new copy). A change that leaves the disk equal to the
// edits, or a re-read that finds nothing new, marks nothing.

export type DiskTexts = {
  baseline: string;
  current: string;
  /** The file changed on disk under unsaved edits, and no choice has been
   *  made yet. Only meaningful while the edits are unsaved. */
  diskChanged?: boolean;
};

/** True while the banner should show: marked, and still unsaved. */
export function hasDiskConflict(file: DiskTexts): boolean {
  return !!file.diskChanged && file.current !== file.baseline;
}

/** The tab after a fresh read of the file from disk. */
export function afterDiskRead<T extends DiskTexts>(file: T, disk: string): T {
  if (file.current === file.baseline) {
    return { ...file, baseline: disk, current: disk, diskChanged: false };
  }
  if (disk === file.baseline) return file;
  return { ...file, baseline: disk, diskChanged: disk !== file.current };
}

/** "Keep mine": the edits stay, and the next save writes them over the copy
 *  now on disk. */
export function keepMyEdits<T extends DiskTexts>(file: T): T {
  return { ...file, diskChanged: false };
}

/** "Discard my edits": the editor shows the copy now on disk. */
export function discardMyEdits<T extends DiskTexts>(file: T): T {
  return { ...file, current: file.baseline, diskChanged: false };
}

/** The tab after typing. Typing back to what is on disk ends the conflict:
 *  there is nothing left to choose between. */
export function afterEdit<T extends DiskTexts>(file: T, text: string): T {
  return { ...file, current: text, diskChanged: text === file.baseline ? false : file.diskChanged };
}

export const SAVE_HELD_MESSAGE = "File changed on disk. Keep or discard your edits to save.";
