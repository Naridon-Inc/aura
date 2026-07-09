// Defer state mirror — `value` only propagates after `delayMs` of
// stillness. Lifted from superset.sh's
// apps/desktop/src/renderer/hooks/useDebouncedValue.ts (MIT-spirit
// utility shape, kept verbatim because there's no improvement to make).

import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
