/** Team (chat) presentation — the compact in-stream sender avatar.
 *
 *  Moved verbatim out of the CommsPanel monolith; logic unchanged.
 *  Imports are filled in after extraction. */

import { animalForName, tintForName } from "../../../lib/identityColors";

export function MiniAvatar({ name, agent }: { name: string; agent?: boolean }) {
  const handle = name.replace(/^@/, "");
  // Agents read as native to Aura, not as roster peers — a square-ish
  // accent monogram instead of the animal-emoji tint humans get.
  if (agent) {
    return (
      <span
        className="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center font-medium uppercase"
        style={{
          background: "color-mix(in srgb, var(--color-accent) 18%, transparent)",
          color: "var(--color-accent)",
          border: "1px solid color-mix(in srgb, var(--color-accent) 32%, transparent)",
          fontSize: 11,
        }}
        title={name}
      >
        {handle.slice(0, 1) || "a"}
      </span>
    );
  }
  return (
    <span
      className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center"
      style={{ background: tintForName(handle), fontSize: 12 }}
      title={name}
    >
      {animalForName(handle)}
    </span>
  );
}
