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
  /** Wall time for the step in ms, when measured (agent_completed events). */
  duration_ms?: number | null;
}

/** A web-search citation attached to an agent's output (Gemini grounding). */
export interface TraceSource {
  title: string;
  url: string;
}

/** A cross-agent contradiction detected by the Critic (debate_round payload). */
export interface Contradiction {
  agents_involved: string[];
  field_a: string;
  value_a: string;
  field_b: string;
  value_b: string;
  resolution: string;
}

/**
 * Known `TraceEvent.payload` shapes by event type (the backend enriches these
 * for the trace graph). Payloads remain dynamic; these document the contract.
 */
export interface AgentCompletedPayload {
  verdict?: string;
  reasoning?: string;
  output?: Record<string, unknown>;
  sources?: TraceSource[];
  confidence?: number;
  flags?: string[];
  revised?: boolean;
}

export interface DebateRoundPayload {
  rejected_agents?: string[];
  approved_agents?: string[];
  revision_requests?: Record<string, string>;
  contradictions?: Contradiction[];
  consistency_score?: number;
  critique_summary?: string;
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
export function streamUrl(planId: string): string {
  return `${API_BASE}/stream/${encodeURIComponent(planId)}`;
}

/** Persisted plan + trace (GET /api/plans/{id}). */
export interface PlanRecord {
  plan_id: string;
  status: "completed" | "pending";
  result: FinalPlan | null;
  trace: TraceEvent[];
}

export async function getPlan(planId: string): Promise<PlanRecord> {
  const res = await fetch(`${API_BASE}/plans/${encodeURIComponent(planId)}`);
  if (!res.ok) throw new ApiError(res.status, `GET /plans failed: ${res.statusText}`);
  return (await res.json()) as PlanRecord;
}

// --- Conversations / versioning (mirrors backend agent_schemas.py) ----------

export type ChatRole = "user" | "assistant";
export type ChatTurnStatus = "collecting" | "ready" | "answer" | "replan";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  created_at: string;
}

export interface PlanVersion {
  version_id: string;
  plan_id: string;
  parent_version_id: string | null;
  label: string;
  change_request: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
  profile: Record<string, unknown>;
  versions: PlanVersion[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updated_at: string;
  version_count: number;
}

export interface ChatTurnResponse {
  assistant_message: string;
  status: ChatTurnStatus;
  profile: Record<string, unknown>;
  version: PlanVersion | null;
  conversation: Conversation;
}

export async function createConversation(): Promise<Conversation> {
  const res = await fetch(`${API_BASE}/conversations`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, "POST /conversations failed");
  return (await res.json()) as Conversation;
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const res = await fetch(`${API_BASE}/conversations`);
  if (!res.ok) throw new ApiError(res.status, "GET /conversations failed");
  return (await res.json()) as ConversationSummary[];
}

export async function getConversation(id: string): Promise<Conversation> {
  const res = await fetch(`${API_BASE}/conversations/${encodeURIComponent(id)}`);
  if (!res.ok) throw new ApiError(res.status, "GET /conversations/{id} failed");
  return (await res.json()) as Conversation;
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new ApiError(res.status, "DELETE /conversations/{id} failed");
}

export async function postChatMessage(
  conversationId: string,
  content: string,
  parentVersionId?: string | null,
): Promise<ChatTurnResponse> {
  const res = await fetch(
    `${API_BASE}/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, parent_version_id: parentVersionId ?? null }),
    },
  );
  if (!res.ok) throw new ApiError(res.status, "POST message failed");
  return (await res.json()) as ChatTurnResponse;
}

export { ApiError };
