/**
 * Typed API client for the Health Plan Optimizer backend.
 *
 * These types mirror backend/schemas/agent_schemas.py one-to-one. Keep them in
 * sync — they are the network contract.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

// --- Enums (string unions matching the Pydantic str enums) ------------------

export type Sex = "male" | "female" | "other";

export type ActivityLevel =
  | "sedentary"
  | "lightly_active"
  | "active"
  | "very_active";

export type PrimaryGoal =
  | "weight_loss"
  | "muscle_gain"
  | "endurance"
  | "general_health";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type AgentName =
  | "coordinator"
  | "nutrition"
  | "macros"
  | "fitness"
  | "risk"
  | "budget"
  | "critic";

export type TraceEventType =
  | "run_started"
  | "agent_started"
  | "agent_completed"
  | "debate_round"
  | "flag_raised"
  | "synthesis"
  | "run_completed"
  | "error";

// --- Payloads ---------------------------------------------------------------

export interface UserProfile {
  age: number;
  weight_kg: number;
  height_cm: number;
  sex: Sex;
  activity_level: ActivityLevel;
  primary_goal: PrimaryGoal;
  medical_conditions: string[];
  dietary_restrictions: string[];
  weekly_budget_inr: number;
  gym_access: boolean;
}

export interface RunRequest {
  profile: UserProfile;
  max_debate_rounds?: number;
  /** Client-supplied id so the SSE trace can be opened before the run starts. */
  run_id?: string;
}

export interface AgentOutput {
  agent_name: string;
  verdict: string;
  confidence: number;
  reasoning: string;
  flags: string[];
  data: Record<string, unknown>;
  round: number;
}

/** Mirrors backend FinalPlan (the POST /api/run response). */
export interface FinalPlan {
  plan_id: string;
  generated_at: string;
  user_summary: string;
  overall_health_score: number;
  nutrition_plan: Record<string, unknown>;
  macros_targets: Record<string, unknown>;
  fitness_programme: Record<string, unknown>;
  risk_assessment: Record<string, unknown>;
  budget_analysis: Record<string, unknown>;
  key_insights: string[];
  action_steps_week_1: string[];
  disclaimer: string;
  debate_rounds: number;
  consistency_score: number;
  final_recommendation_safe: boolean;
}

export interface TraceEvent {
  run_id: string;
  seq: number;
  type: TraceEventType;
  agent_name: AgentName | null;
  round: number | null;
  message: string;
  payload: Record<string, unknown>;
  ts: number;
}

// --- Client -----------------------------------------------------------------

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** POST /api/run — start a full multi-agent optimisation run. */
export async function runPlan(
  request: RunRequest,
  signal?: AbortSignal,
): Promise<FinalPlan> {
  const res = await fetch(`${API_BASE}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_debate_rounds: 3, ...request }),
    signal,
  });
  if (!res.ok) {
    throw new ApiError(res.status, `POST /run failed: ${res.statusText}`);
  }
  return (await res.json()) as FinalPlan;
}

/** Absolute URL for the SSE trace stream — consumed by useTraceStream. */
export function streamUrl(runId: string): string {
  return `${API_BASE}/stream?run_id=${encodeURIComponent(runId)}`;
}

export { ApiError };
