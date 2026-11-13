import { ShellNotice } from "../ui/shell-notice";

// Auto-update needs a writable install location. That's false in three cases
// the user can fix by moving Aura to Applications: a read-only mounted DMG
// (`/Volumes/…`), a Gatekeeper App-Translocation quarantine path, or any other
// read-only spot. Keying on `!writable` (not just "translocated") covers all
// three; the message is tailored to whichever it is.

export function InstallLocationNotice({
  bundlePath,
  writable,
  dismissed,
  onDismiss,
}: {
  bundlePath: string | null | undefined;
  writable: boolean | null | undefined;
  dismissed: boolean;
  onDismiss: () => void;
}) {
  if (dismissed || !bundlePath || writable !== false) return null;
  const onDmg = bundlePath.startsWith("/Volumes/");
  return (
    <ShellNotice
      tone="attention"
      onDismiss={onDismiss}
      detail={<code title={bundlePath}>{bundlePath}</code>}
    >
      <strong>
        {onDmg
          ? "Aura is running from the disk image. Updates won’t install."
          : "Auto-update disabled: app is running from a read-only quarantine."}
      </strong>{" "}
      {onDmg
        ? "Drag Aura into your Applications folder, then open it from there."
        : "Move Aura.app into ~/Applications to re-enable auto-update."}
    </ShellNotice>
  );
}
