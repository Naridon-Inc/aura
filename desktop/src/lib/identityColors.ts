// Identity colour + animal-monogram helpers, shared by the team chat
// (CommsPanel) and the sidebar's Team notification avatars (AdeSidebar)
// so the same person always reads as the same colour + animal in both
// places. Humans get a deterministic animal emoji on a tinted circle;
// the hash is stable across reloads (pure name → palette index).

export const PALETTE = [
  "#5b8def", "#8fa96e", "#d77acd", "#e7a44e", "#7ad7c0",
  "#c97a7a", "#a78bfa", "#f08a5d", "#3aafa9", "#e94e77",
  "#9b8cf3", "#5ec4b6",
];

export const ANIMALS = [
  "🐶", "🐱", "🦊", "🐼", "🐨", "🐯", "🦁", "🐮",
  "🐷", "🐸", "🐵", "🐔", "🐧", "🦄", "🦉", "🦋",
  "🐢", "🐙", "🦀", "🐠", "🐳", "🦒", "🦔", "🐝",
];

export function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function colorForName(name: string): string {
  return PALETTE[hashName(name) % PALETTE.length];
}

export function animalForName(name: string): string {
  return ANIMALS[hashName(name) % ANIMALS.length];
}

export function tintForName(name: string): string {
  return `${colorForName(name)}26`;
}
