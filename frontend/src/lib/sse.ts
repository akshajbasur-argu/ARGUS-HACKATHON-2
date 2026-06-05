/**
 * SSE hook for the live Agent Trace View.
 *
 * Subscribes to GET /api/stream?run_id=... and accumulates TraceEvent frames.
 * Pass `runId = null` to stay idle.
 */
import { useEffect, useRef, useState } from "react";
import { streamUrl, type TraceEvent } from "./api";

export interface TraceStreamState {
  events: TraceEvent[];
  connected: boolean;
  error: string | null;
}

export function useTraceStream(runId: string | null): TraceStreamState {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!runId) return;

    setEvents([]);
    setError(null);

    const source = new EventSource(streamUrl(runId));
    sourceRef.current = source;

    source.onopen = () => setConnected(true);

    source.onmessage = (e: MessageEvent<string>) => {
      try {
        const event = JSON.parse(e.data) as TraceEvent;
        setEvents((prev) => [...prev, event]);
        if (event.type === "run_completed" || event.type === "error") {
          source.close();
          setConnected(false);
        }
      } catch {
        // Ignore malformed frames (e.g. keep-alive comments).
      }
    };

    source.onerror = () => {
      setError("trace stream disconnected");
      setConnected(false);
      source.close();
    };

    return () => {
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [runId]);

  return { events, connected, error };
}
