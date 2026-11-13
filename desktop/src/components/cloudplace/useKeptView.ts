// State a cloud view starts from what it showed the last time it was open.
//
// A workspace's conversation, its panel and its sharing were each read into
// component state that began empty, so every visit — switching workspaces,
// leaving Cloud and coming back — opened on a spinner and read everything
// again from nothing. Each of those views keeps its state here instead: the
// value is seeded from the window's cache under the view's key, every change
// is written back, and the view's own reads carry on refreshing it in the
// background.
//
// Keys are `cloud:` keys (viewKey), so they are kept for the window only and
// dropped the moment the account or organization changes; a view open at
// that moment starts again from nothing.

import { useCallback, useEffect, useRef, useState } from "react";

import { accountEpoch, onAccountScopeChanged, peekCache, writeCache } from "../../lib/resourceCache";

type Held<T> = { key: string; epoch: number; value: T; changed: boolean };

function heldAt<T>(key: string, nothing: T): Held<T> {
  const cached = peekCache<T>(key);
  return { key, epoch: accountEpoch(), value: cached === undefined ? nothing : cached, changed: false };
}

/**
 * `[value, change]` for the view under `key`. `value` is what the view showed
 * last time (or `nothing`); `change(step)` moves it on and keeps the result.
 * A `change` made for one key never lands on another: a read that comes back
 * after the view moved to another workspace is dropped.
 */
export function useKeptView<T>(key: string, nothing: T): readonly [T, (step: (prev: T) => T) => void] {
  const empty = useRef(nothing);
  empty.current = nothing;
  const [held, setHeld] = useState<Held<T>>(() => heldAt(key, nothing));
  // Another key is another view: it starts from what that one showed.
  const now = held.key === key ? held : heldAt(key, nothing);
  if (now !== held) setHeld(now);

  const change = useCallback(
    (step: (prev: T) => T) =>
      setHeld((h) => (h.key === key ? { ...h, value: step(h.value), changed: true } : h)),
    [key],
  );

  useEffect(() => {
    if (held.changed && held.epoch === accountEpoch()) writeCache(held.key, held.value);
  }, [held]);

  useEffect(
    () =>
      onAccountScopeChanged(() =>
        setHeld((h) => ({ key: h.key, epoch: accountEpoch(), value: empty.current, changed: false })),
      ),
    [],
  );

  return [now.value, change] as const;
}
