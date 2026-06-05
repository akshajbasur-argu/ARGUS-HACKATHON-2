"""Intake / Concierge Agent — the conversational front-of-house.

Sits before the Coordinator: it chats with the user, extracts the UserProfile
field-by-field, and classifies every turn as collecting | ready | answer | replan.
The API layer acts on that classification (ask again / run the initial plan /
answer from the current plan / run a new plan version).

Like every agent it makes a live Gemini call and hard-requires GEMINI_API_KEY —
there is no offline fallback (consistent with the rest of the system).

Run standalone (needs GEMINI_API_KEY):
    python -m features.agents.intake_agent
"""

from __future__ import annotations

# --- standalone bootstrap: put backend/ on sys.path when run as a script ------
if __name__ == "__main__" and __package__ in (None, ""):
    import pathlib
    import sys

    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
# ------------------------------------------------------------------------------

import asyncio
import json
from typing import Any

from pydantic import BaseModel, Field

from features.agents.base import call_claude, extract_json
from schemas.agent_schemas import ChatMessage, ChatTurnStatus, FinalPlan

# Required profile fields (the partial profile is "ready" once all are present).
REQUIRED_FIELDS = (
    "age",
    "weight_kg",
    "height_cm",
    "sex",
    "activity_level",
    "primary_goal",
    "weekly_budget_inr",
)


INTAKE_SYSTEM_PROMPT = """\
You are the warm, concise intake concierge for HealthFlow — a multi-agent health
planning system. You chat with the user to assemble a complete health profile,
then hand off to the specialist agents (nutrition, macros, fitness, risk, budget).
After a plan exists you also field follow-up questions and change requests.

Respond with ONLY one valid JSON object — no preamble, no markdown fences:
{
  "assistant_message": "<your conversational reply to the user>",
  "profile_patch": { <ONLY fields you learned or changed THIS turn> },
  "status": "collecting" | "ready" | "answer" | "replan",
  "plan_change": "<for replan only: a concise directive describing what to change; else null>"
}

PROFILE FIELDS (map natural language onto these exact keys/enums):
- age: integer 16-100
- weight_kg: number
- height_cm: number
- sex: "male" | "female" | "other"
- activity_level: "sedentary" | "lightly_active" | "active" | "very_active"
- primary_goal: "weight_loss" | "muscle_gain" | "endurance" | "general_health"
- weekly_budget_inr: number (>= 500)
- medical_conditions: array of strings ([] if none)
- dietary_restrictions: array of strings ([] if none)
- gym_access: boolean

STATUS RULES:
- "collecting": at least one REQUIRED field (age, weight_kg, height_cm, sex,
  activity_level, primary_goal, weekly_budget_inr) is still missing or ambiguous.
  Warmly ask for the missing ones — a couple at a time, never a giant form dump.
- "ready": you now have ALL required fields and NO plan exists yet. Briefly
  confirm and say you are generating their plan.
- "answer": a plan ALREADY exists and the user is ASKING about it (no change).
  Answer using the CURRENT PLAN context provided. Leave the profile unchanged.
- "replan": a plan ALREADY exists and the user wants it CHANGED (e.g. "make it
  cheaper", "add more protein", "I now have gym access"). Put a concise directive
  in plan_change, reflect any concrete profile changes in profile_patch, and say
  you are regenerating the plan.

GUIDELINES:
- Map phrases to enums: "lose weight"->weight_loss, "build muscle"->muscle_gain,
  "I sit all day"->sedentary, "I run daily"->very_active, "veg"->vegetarian.
- Never invent values the user didn't give. profile_patch holds ONLY this turn's
  confidently-known fields (the server merges them).
- Keep replies short, friendly, and specific.
"""


class IntakeResult(BaseModel):
    assistant_message: str
    profile_patch: dict[str, Any] = Field(default_factory=dict)
    status: ChatTurnStatus
    plan_change: str | None = None


def missing_required(profile: dict[str, Any]) -> list[str]:
    """Required fields still absent/blank from the partial profile."""
    return [
        f
        for f in REQUIRED_FIELDS
        if profile.get(f) in (None, "", [])
    ]


def _plan_context(plan: FinalPlan | None) -> str:
    if plan is None:
        return ""
    return (
        "\n\nCURRENT PLAN (latest version — use for answer/replan):\n"
        + json.dumps(
            {
                "user_summary": plan.user_summary,
                "overall_health_score": plan.overall_health_score,
                "key_insights": plan.key_insights,
                "macros_targets": plan.macros_targets,
                "budget_analysis": {
                    k: plan.budget_analysis.get(k)
                    for k in ("total_weekly_cost_inr", "within_budget", "user_budget_inr")
                },
                "final_recommendation_safe": plan.final_recommendation_safe,
            },
            default=str,
        )[:2500]
    )


def _transcript(messages: list[ChatMessage], limit: int = 12) -> str:
    recent = messages[-limit:]
    return "\n".join(f"{m.role.value}: {m.content}" for m in recent)


async def run(
    messages: list[ChatMessage],
    profile: dict[str, Any],
    *,
    latest_plan: FinalPlan | None = None,
    has_plan: bool = False,
) -> IntakeResult:
    """Classify the latest turn and return the concierge's structured reply."""
    user_content = (
        f"PROFILE COLLECTED SO FAR (partial):\n{json.dumps(profile, default=str)}\n\n"
        f"A PLAN ALREADY EXISTS: {has_plan}"
        f"{_plan_context(latest_plan)}\n\n"
        f"CONVERSATION SO FAR:\n{_transcript(messages)}"
    )

    raw = await call_claude(
        INTAKE_SYSTEM_PROMPT,
        user_content,
        temperature=0.4,
        max_tokens=1024,
        prefill="{",
    )
    parsed = extract_json(raw)

    status_raw = str(parsed.get("status", "collecting")).strip().lower()
    try:
        status = ChatTurnStatus(status_raw)
    except ValueError:
        status = ChatTurnStatus.COLLECTING

    patch = parsed.get("profile_patch")
    patch = patch if isinstance(patch, dict) else {}
    plan_change = parsed.get("plan_change")
    plan_change = str(plan_change).strip() if plan_change else None

    return IntakeResult(
        assistant_message=str(parsed.get("assistant_message", "")).strip()
        or "Could you tell me a bit more?",
        profile_patch=patch,
        status=status,
        plan_change=plan_change,
    )


# ---------------------------------------------------------------------------
# Standalone test harness
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from schemas.agent_schemas import ChatRole

    async def _main() -> None:
        msgs = [
            ChatMessage(
                role=ChatRole.USER,
                content="Hi! I'm a 34 year old man, 88kg, 175cm. I want to lose weight.",
            )
        ]
        result = await run(msgs, {})
        print(result.model_dump_json(indent=2))

    asyncio.run(_main())
