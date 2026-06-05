import { useState } from "react";
import AppShell, { type AgentStatus } from "./components/layout/AppShell";
import OnboardingForm from "./features/onboarding/OnboardingForm";
import AgentTracePanel from "./features/agent-trace/AgentTracePanel";
import ResultsPanel from "./features/dashboard/ResultsPanel";
import type { FinalPlan } from "./lib/api";

/**
 * Phase 1 wiring: VibeFlow shell + onboarding form + live Agent Trace +
 * Results dashboard. End-to-end: profile -> agents -> debate -> plan.
 */
export default function App() {
  const [planId, setPlanId] = useState<string | null>(null);
  const [status, setStatus] = useState<AgentStatus>("ready");
  const [plan, setPlan] = useState<FinalPlan | null>(null);

  return (
    <AppShell
      status={status}
      onboarding={
        <OnboardingForm
          onPlanStart={(id) => {
            setPlanId(id);
            setPlan(null);
            setStatus("running");
          }}
          onPlanComplete={(p) => {
            setPlan(p);
            setStatus("done");
          }}
          onError={() => setStatus("error")}
        />
      }
      trace={<AgentTracePanel planId={planId} />}
      results={
        plan ? (
          <ResultsPanel plan={plan} />
        ) : (
          <div className="flex h-full min-h-[12rem] flex-col items-center justify-center text-center text-content-muted">
            <span className="text-3xl">✨</span>
            <p className="mt-2 text-sm">Your plan will appear here once the agents finish.</p>
          </div>
        )
      }
    />
  );
}
