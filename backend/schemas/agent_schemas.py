"""Pydantic v2 models — the shared contract between agents, API, and frontend.

These schemas are the single source of truth for every payload that crosses an
agent boundary or the network. Keep field names aligned with the TypeScript
types in `frontend/src/lib/api.ts`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class Sex(str, Enum):
    MALE = "male"
    FEMALE = "female"
    OTHER = "other"


class ActivityLevel(str, Enum):
    SEDENTARY = "sedentary"
    LIGHTLY_ACTIVE = "lightly_active"
    ACTIVE = "active"
    VERY_ACTIVE = "very_active"


class PrimaryGoal(str, Enum):
    WEIGHT_LOSS = "weight_loss"
    MUSCLE_GAIN = "muscle_gain"
    ENDURANCE = "endurance"
    GENERAL_HEALTH = "general_health"


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class AgentName(str, Enum):
    COORDINATOR = "coordinator"
    NUTRITION = "nutrition"
    MACROS = "macros"
    FITNESS = "fitness"
    RISK = "risk"
    BUDGET = "budget"
    CRITIC = "critic"


# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------


class UserProfile(BaseModel):
    """The intake payload submitted from the onboarding feature."""

    age: int = Field(..., ge=16, le=100)
    weight_kg: float = Field(..., ge=30, le=300)
    height_cm: float = Field(..., ge=100, le=250)
    sex: Sex
    activity_level: ActivityLevel
    primary_goal: PrimaryGoal
    medical_conditions: list[str] = Field(default_factory=list)
    dietary_restrictions: list[str] = Field(default_factory=list)
    weekly_budget_inr: float = Field(..., ge=500)
    gym_access: bool = True


class RunRequest(BaseModel):
    """Body for POST /api/run."""

    profile: UserProfile
    max_debate_rounds: int = Field(default=3, ge=1, le=3)
    # Optional client-supplied id so the SSE trace can be opened *before* the
    # run starts (enables live streaming). One is generated if omitted.
    run_id: str | None = None


# ---------------------------------------------------------------------------
# Agent output
# ---------------------------------------------------------------------------


class AgentOutput(BaseModel):
    """The structured verdict every specialist agent must return."""

    agent_name: str
    verdict: str
    confidence: float = Field(..., ge=0.0, le=1.0)
    reasoning: str
    flags: list[str] = Field(default_factory=list)
    data: dict[str, Any] = Field(default_factory=dict)
    round: int = 1


class FinalRecommendation(BaseModel):
    """The Coordinator's synthesised plan returned by POST /api/run."""

    run_id: str
    summary: str
    confidence: float = Field(..., ge=0.0, le=1.0)
    overall_risk: RiskLevel = RiskLevel.LOW
    agent_outputs: list[AgentOutput] = Field(default_factory=list)
    open_flags: list[str] = Field(default_factory=list)
    plan: dict[str, Any] = Field(default_factory=dict)


class FinalPlan(BaseModel):
    """The rich, user-facing plan synthesised by the Coordinator (POST /api/run)."""

    plan_id: str
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    user_summary: str
    overall_health_score: float = Field(..., ge=0.0, le=10.0)

    nutrition_plan: dict[str, Any] = Field(default_factory=dict)
    macros_targets: dict[str, Any] = Field(default_factory=dict)
    fitness_programme: dict[str, Any] = Field(default_factory=dict)
    risk_assessment: dict[str, Any] = Field(default_factory=dict)
    budget_analysis: dict[str, Any] = Field(default_factory=dict)

    key_insights: list[str] = Field(default_factory=list)
    action_steps_week_1: list[str] = Field(default_factory=list)
    disclaimer: str = ""

    # Debate metadata (useful for the trace view / UI; not in the minimal spec).
    debate_rounds: int = 1
    consistency_score: float = 1.0
    final_recommendation_safe: bool = True


# ---------------------------------------------------------------------------
# Trace streaming (GET /api/stream)
# ---------------------------------------------------------------------------


class TraceEventType(str, Enum):
    RUN_STARTED = "run_started"
    AGENT_STARTED = "agent_started"
    AGENT_COMPLETED = "agent_completed"
    DEBATE_ROUND = "debate_round"
    FLAG_RAISED = "flag_raised"
    SYNTHESIS = "synthesis"
    RUN_COMPLETED = "run_completed"
    ERROR = "error"


class TraceEvent(BaseModel):
    """A single SSE frame streamed to the live Agent Trace View.

    Field-name note: 1.D.1 specifies `event_type`/`timestamp`; this model keeps
    the already-integrated `type`/`ts` (consumed by the frontend sse.ts +
    AgentTraceView and the HTTP tests) and adds `duration_ms`. Renaming would
    break the verified contract for no functional gain.
    """

    run_id: str
    seq: int
    type: TraceEventType
    agent_name: str | None = None
    round: int | None = None
    message: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)
    ts: float  # epoch seconds
    duration_ms: float | None = None  # wall time for the step, when measured


# ---------------------------------------------------------------------------
# Conversation + plan-version DAG (chat / versioning / history)
# ---------------------------------------------------------------------------


class ChatRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"


class ChatTurnStatus(str, Enum):
    COLLECTING = "collecting"  # still gathering profile fields — ask follow-ups
    READY = "ready"            # profile complete -> trigger the initial plan run
    ANSWER = "answer"          # a question about the current plan; answer, no re-run
    REPLAN = "replan"          # a change request -> run a new plan version


class ChatMessage(BaseModel):
    role: ChatRole
    content: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class PlanVersion(BaseModel):
    """One node in a conversation's branchable plan-version DAG.

    `plan_id` points at the existing FinalPlan + TraceEvent[] in the store, so all
    the run/trace machinery is reused unchanged per version.
    """

    version_id: str
    plan_id: str
    parent_version_id: str | None = None
    label: str = ""
    change_request: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class Conversation(BaseModel):
    """Top-level entity: a chat that owns a profile + a DAG of plan versions."""

    id: str
    title: str = "New chat"
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    messages: list[ChatMessage] = Field(default_factory=list)
    # Partial UserProfile assembled through chat; validated into UserProfile only
    # once every required field is present (status "ready").
    profile: dict[str, Any] = Field(default_factory=dict)
    versions: list[PlanVersion] = Field(default_factory=list)


class ConversationSummary(BaseModel):
    """Lightweight sidebar list item."""

    id: str
    title: str
    updated_at: datetime
    version_count: int = 0


class ChatMessageRequest(BaseModel):
    """Body for POST /api/conversations/{id}/messages."""

    content: str
    # The version the user is currently viewing; a replan branches from here.
    parent_version_id: str | None = None


class ChatTurnResponse(BaseModel):
    """Result of a chat turn: assistant reply + any newly-spawned plan version."""

    assistant_message: str
    status: ChatTurnStatus
    profile: dict[str, Any] = Field(default_factory=dict)
    version: PlanVersion | None = None  # set when the turn started a new run
    conversation: Conversation
