// Numbers as a reader says them: 192,463 rather than 192463.

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString();
}
