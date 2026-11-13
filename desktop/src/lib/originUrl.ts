// The `origin` remote URL as text. The read crosses the native bridge (and, on
// a machine, the network), so its answer is checked here rather than trusted:
// anything that isn't a string reads as "no remote".

export function originText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
