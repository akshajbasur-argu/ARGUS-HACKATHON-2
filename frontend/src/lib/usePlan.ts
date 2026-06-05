/**
 * usePlan — fetch a version's FinalPlan, polling while the run is still in flight.
 *
 * A conversation turn spawns the pipeline as a background task, so the plan for a
 * new version isn't ready immediately. This hook polls GET /api/plans/{id} until
 * the result lands (or the planId changes), decoupling the Plan view from the
 * live trace stream.
 */
import { useEffect, useState } from "react";
import { getPlan, type FinalPlan } from "./api";

export type PlanStatus = "idle" | "pending" | "completed";

const POLL_MS = 2500;

export function usePlan(planId: string | null): {
  plan: FinalPlan | null;
  status: PlanStatus;
} {
  const [plan, setPlan] = useState<FinalPlan | null>(null);
  const [status, setStatus] = useState<PlanStatus>("idle");

  useEffect(() => {
    if (!planId) {
      setPlan(null);
      setStatus("idle");
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPlan(null);
    setStatus("pending");

    const poll = async () => {
      try {
        const rec = await getPlan(planId);
        if (!active) return;
        if (rec.result) {
          setPlan(rec.result);
          setStatus("completed");
          return; // stop polling once the plan is ready
        }
      } catch {
        // transient — keep polling
      }
      if (active) timer = setTimeout(poll, POLL_MS);
    };
    poll();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [planId]);

  return { plan, status };
}
