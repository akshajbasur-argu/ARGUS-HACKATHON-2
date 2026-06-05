/**
 * WorkspacePanel — the right column: the version switcher plus tabbed
 * Trace (live agent graph) / Plan (the rendered FinalPlan) views.
 *
 * Selecting a version in the VersionGraph re-points both tabs (the trace stream
 * and the plan) at that version's plan_id.
 */
import { useState } from "react";
import type { FinalPlan, PlanVersion } from "../../lib/api";
import type { PlanStatus } from "../../lib/usePlan";
import AgentTracePanel from "../agent-trace/AgentTracePanel";
import ResultsPanel from "../dashboard/ResultsPanel";
import VersionGraph from "../versions/VersionGraph";

type Tab = "trace" | "plan";

interface WorkspacePanelProps {
  planId: string | null;
  versions: PlanVersion[];
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
  plan: FinalPlan | null;
  planStatus: PlanStatus;
}

function PlanView({
  plan,
  planStatus,
}: {
  plan: FinalPlan | null;
  planStatus: PlanStatus;
}) {
  if (plan) return <ResultsPanel plan={plan} />;
  if (planStatus === "pending") {
    return (
      <div className="flex h-full min-h-[16rem] flex-col items-center justify-center text-center text-content-muted">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-accent-primary/30 border-t-accent-primary" />
        <p className="mt-3 text-sm">Agents are building this plan — watch the Trace tab live.</p>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-[16rem] flex-col items-center justify-center text-center text-content-muted">
      <span className="text-3xl">✨</span>
      <p className="mt-2 text-sm">Your plan will appear here once a version is generated.</p>
    </div>
  );
}

export default function WorkspacePanel({
  planId,
  versions,
  selectedVersionId,
  onSelectVersion,
  plan,
  planStatus,
}: WorkspacePanelProps) {
  const [tab, setTab] = useState<Tab>("trace");

  return (
    <div className="flex h-full flex-col">
      {versions.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-display text-xs uppercase tracking-wide text-content-muted">
              Plan versions
            </span>
            <span className="text-[10px] text-content-muted">click to switch</span>
          </div>
          <div className="h-[7.5rem] overflow-hidden rounded-md border border-border bg-surface-1/40">
            <VersionGraph
              versions={versions}
              selectedVersionId={selectedVersionId}
              onSelect={onSelectVersion}
            />
          </div>
        </div>
      )}

      <div className="mb-3 flex justify-center">
        <div className="glass flex rounded-pill p-0.5 text-xs">
          {(["trace", "plan"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-pill px-4 py-1 font-medium transition-colors ${
                tab === t
                  ? "bg-accent-primary-soft text-accent-primary"
                  : "text-content-muted hover:text-content-secondary"
              }`}
            >
              {t === "trace" ? "Trace" : "Plan"}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "trace" ? (
          <AgentTracePanel planId={planId} />
        ) : (
          <PlanView plan={plan} planStatus={planStatus} />
        )}
      </div>
    </div>
  );
}
