// SessionTranscript — the Tauri side of the shared TranscriptView: replay a
// local session store into StreamEvents, then render the exact component the
// web console renders. The view moved to aura-shared/ui/transcript; what
// stays here is the only part a browser cannot do — reading the disk.

import { useEffect, useState } from "react";
import { type StreamEvent } from "../../lib/api";
import {
  loadSessionEvents,
  type TranscriptSource,
} from "../../lib/sessionDataCache";
import { useResolvedTheme } from "../../lib/themeStore";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { TranscriptView } from "@shared/ui/transcript/TranscriptView";

export function SessionTranscript({
  filePath,
  agentId = "claude",
  source = "claude",
}: {
  /** For a Claude session this is the JSONL `file_path`; for a native Aura
   *  chat (`source="manager"`) it is the manager session id. */
  filePath: string;
  agentId?: string;
  /** Which on-disk store to replay from. Defaults to a Claude JSONL read. */
  source?: TranscriptSource;
}) {
  const [events, setEvents] = useState<StreamEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const theme = useResolvedTheme();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setEvents(null);
    loadSessionEvents(filePath, 1000, source)
      .then((evts) => {
        if (alive) setEvents(Array.isArray(evts) ? evts : []);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [filePath, source]);

  return (
    <TranscriptView
      events={events}
      loading={loading}
      error={error}
      agentId={agentId}
      theme={theme}
      onAnchorClick={onExternalAnchorClick}
    />
  );
}
