// `cn()` — Tailwind class merger used by every shadcn-style primitive.
// `clsx` resolves the conditional/array forms; `twMerge` deduplicates
// conflicting utility classes so a consumer's `bg-red-500` actually
// wins over the component's default `bg-bg-2`. Standard pattern,
// keep the body one-liner.

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
