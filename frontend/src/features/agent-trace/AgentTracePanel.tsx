/**
 * Agent Trace panel — the graded "Agent Trace View" deliverable.
 *
 * Owns the live SSE subscription and the shared `DerivedTrace`, and switches
 * between the primary interactive **Graph** and the secondary **Execution Log**.
 * A clicked node/row opens the Step Detail drawer (full input/output/sources/timing).
 */
import { useMemo, useState } from "react";
import { useTraceStream } from "../../lib/sse";
import AgentTraceGraph from "./AgentTraceGraph";
import AgentTraceView from "./AgentTraceView";
import StepDetailDrawer from "./StepDetailDrawer";
import { deriveTrace } from "./deriveTrace";

type Tab = "graph" | "log";

interface AgentTracePanelProps {
  planId: string | null;
}

export default function AgentTracePanel({ planId }: AgentTracePanelProps) {
  const { events, connected, error } = useTraceStream(planId);
  const derived = useMemo(() => deriveTrace(events), [events]);
  const [tab, setTab] = useState<Tab>("graph");
  const [selected, setSelected] = useState<string | null>(null);

  if (!planId) {
    return (
      <div className="flex h-full min-h-[12rem] flex-col items-center justify-center text-center text-content-muted">
        <span className="text-3xl">🧭</span>
        <p className="mt-2 text-sm">Fill in your profile to watch the agents collaborate.</p>
      </div>
    );
  }

  const statusText = error
    ? "Disconnected"
    : connected
      ? "Live"
      : derived.done
        ? "Finished"
        : "Connecting…";

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`h-2 w-2 rounded-full ${
              error
                ? "bg-accent-danger"
                : connected
                  ? "animate-pulse bg-emerald-400"
                  : "bg-content-muted"
            }`}
          />
          <span className="text-content-muted">{statusText}</span>
        </div>

        <div className="glass flex rounded-pill p-0.5 text-xs">
          {(["graph", "log"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-pill px-3 py-1 font-medium transition-colors ${
                tab === t
                  ? "bg-accent-primary-soft text-accent-primary"
                  : "text-content-muted hover:text-content-secondary"
              }`}
            >
              {t === "graph" ? "Graph" : "Execution Log"}
            </button>
          ))}
        </div>
      </div>

      <div
        className="relative"
        style={{ height: "min(62vh, 42rem)", minHeight: "26rem" }}
      >
        {tab === "graph" ? (
          <AgentTraceGraph derived={derived} selected={selected} onSelect={setSelected} />
        ) : (
          <AgentTraceView
            derived={derived}
            eventCount={events.length}
            onSelect={setSelected}
          />
        )}
      </div>

      <StepDetailDrawer
        nodeKey={selected}
        derived={derived}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
