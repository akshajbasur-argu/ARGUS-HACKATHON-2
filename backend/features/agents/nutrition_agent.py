"""Nutrition Research Agent — personalised diet plan, meal suggestions, rationale.

Receives a self-contained sub_task from the Coordinator plus the UserProfile,
makes one Gemini call, and returns a validated AgentOutput whose `data` field
holds a structured 5-meal diet plan.

Run standalone (needs GEMINI_API_KEY):
    python -m features.agents.nutrition_agent      # from backend/
    python features/agents/nutrition_agent.py      # also works (see bootstrap)
"""

from __future__ import annotations

# --- standalone bootstrap: put backend/ on sys.path when run as a script ------
if __name__ == "__main__" and __package__ in (None, ""):
    import pathlib
    import sys

    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
# ------------------------------------------------------------------------------

import asyncio

from pydantic import BaseModel, ValidationError

from features.agents.base import (
    AgentParseError,
    SessionContext,
    call_claude,
    extract_json,
)
from features.agents.search import tavily_search
from schemas.agent_schemas import AgentName, AgentOutput, UserProfile

AGENT_NAME = AgentName.NUTRITION

DEFAULT_CONFIDENCE = 0.85
LOW_CONFIDENCE = 0.60  # applied when medical_conditions > 2


NUTRITION_SYSTEM_PROMPT = """\
You are an expert clinical nutritionist and registered dietitian. You design \
safe, practical, culturally-appropriate diet plans grounded in evidence.

You receive a single sub_task describing one user (age, sex, body metrics, goal, \
dietary restrictions, medical conditions, and weekly budget). Honour every \
constraint:
- Respect all dietary restrictions absolutely (e.g. vegetarian, vegan, halal).
- Keep foods realistic and affordable for the stated budget and currency.
- If the user is diabetic (type 1 or type 2), prioritise LOW glycaemic-index \
foods, avoid refined carbs and sugary items, and distribute carbohydrates \
evenly across meals.
- Adapt portions and calories to the goal (weight_loss -> modest deficit; \
muscle_gain -> modest surplus with high protein; endurance/general_health -> \
maintenance-leaning).

Respond with ONLY one valid JSON object — no preamble, no markdown fences:
{
  "verdict": "<one concise sentence summarising the diet recommendation>",
  "reasoning": "<2-4 sentences justifying the plan from the profile>",
  "flags": ["<short concern strings, or empty>"],
  "data": {
    "daily_calories": <int>,
    "meal_plan": [
      {"meal": "<name>", "foods": ["<food>", ...], "calories": <int>}
    ],
    "foods_to_avoid": ["<food>", ...],
    "hydration_litres": <float>,
    "supplement_suggestions": ["<supplement>", ...]
  }
}

Hard requirements:
- meal_plan MUST contain exactly 5 meals (e.g. Breakfast, Mid-morning, Lunch, \
Evening snack, Dinner).
- The sum of meal calories should approximately equal daily_calories.
- daily_calories and every meal "calories" are integers; hydration_litres is a \
number.
"""


class _MealItem(BaseModel):
    meal: str
    foods: list[str]
    calories: int


class _NutritionData(BaseModel):
    """Strict validation of the AgentOutput.data payload."""

    daily_calories: int
    meal_plan: list[_MealItem]
    foods_to_avoid: list[str]
    hydration_litres: float
    supplement_suggestions: list[str]


def _is_diabetic(profile: UserProfile) -> bool:
    return any("diabet" in c.lower() for c in profile.medical_conditions)


def _confidence_for(profile: UserProfile) -> float:
    return LOW_CONFIDENCE if len(profile.medical_conditions) > 2 else DEFAULT_CONFIDENCE


def _search_query(profile: UserProfile) -> str:
    """e.g. 'weight loss vegetarian diet plan India 2024'."""
    goal = profile.primary_goal.value.replace("_", " ")
    diet = profile.dietary_restrictions[0].lower() if profile.dietary_restrictions else ""
    return " ".join(p for p in (goal, diet, "diet plan India 2024") if p)


def _research_block(results: list[dict[str, str]]) -> str:
    lines = [
        f"- {r['title']}: {r['content'][:500]} ({r['url']})"
        for r in results
        if r.get("content") or r.get("title")
    ]
    return (
        "\n\nWEB RESEARCH CONTEXT (recent sources; use to ground food/cost choices, "
        "do NOT copy verbatim):\n" + "\n".join(lines)
    )


async def run(
    sub_task: str,
    profile: UserProfile,
    *,
    peer_context: dict | None = None,
    round: int = 1,
    session_context: SessionContext | None = None,
) -> AgentOutput:
    """Produce a validated nutrition AgentOutput for the given sub_task."""
    user_message = sub_task
    if peer_context:
        user_message += (
            "\n\nPeer agent context for this debate round "
            f"(round {round}); reconcile any conflicts:\n{peer_context}"
        )
    if session_context:
        user_message += session_context.revision_block(AGENT_NAME.value)

    # Web-search grounding (best-effort; no-op without TAVILY_API_KEY).
    results = await tavily_search(_search_query(profile), max_results=2)
    sources = [r["url"] for r in results if r.get("url")]
    system_prompt = NUTRITION_SYSTEM_PROMPT
    if results:
        system_prompt += _research_block(results)

    raw = await call_claude(
        system_prompt,
        user_message,
        temperature=0.5,
        max_tokens=2048,
        prefill="{",
    )
    parsed = extract_json(raw)

    # Validate the structured plan; surface bad LLM output as a parse error.
    try:
        data = _NutritionData.model_validate(parsed.get("data", {}))
    except ValidationError as exc:
        raise AgentParseError(f"Nutrition data failed validation: {exc}") from exc

    if len(data.meal_plan) != 5:
        raise AgentParseError(
            f"meal_plan must have exactly 5 meals, got {len(data.meal_plan)}"
        )

    flags: list[str] = [str(f) for f in parsed.get("flags", []) if str(f).strip()]
    if _is_diabetic(profile) and not any("gi" in f.lower() or "diabet" in f.lower() for f in flags):
        flags.append("diabetic_profile: low-GI foods prioritised")

    # Attach the sources used for grounding (empty when search was unavailable).
    data_dict = data.model_dump()
    data_dict["sources"] = sources

    return AgentOutput(
        agent_name=AGENT_NAME.value,
        verdict=str(parsed.get("verdict", "")).strip() or "Diet plan generated",
        confidence=_confidence_for(profile),
        reasoning=str(parsed.get("reasoning", "")).strip(),
        flags=flags,
        data=data_dict,
        round=round,
    )


# ---------------------------------------------------------------------------
# Standalone test harness
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from schemas.agent_schemas import ActivityLevel, PrimaryGoal, Sex

    demo_profile = UserProfile(
        age=34,
        weight_kg=88,
        height_cm=175,
        sex=Sex.MALE,
        activity_level=ActivityLevel.LIGHTLY_ACTIVE,
        primary_goal=PrimaryGoal.WEIGHT_LOSS,
        medical_conditions=["type_2_diabetes"],
        dietary_restrictions=["vegetarian"],
        weekly_budget_inr=2500,
        gym_access=True,
    )
    demo_sub_task = (
        "You are the Nutrition Agent. The user is a 34-year-old vegetarian male, "
        "88kg, 175cm, goal: weight_loss, medical: type_2_diabetes, "
        "budget: INR 2500/week. Design a complete 5-meal daily diet plan."
    )

    async def _main() -> None:
        try:
            output = await run(demo_sub_task, demo_profile)
        except Exception as exc:  # noqa: BLE001 — surface any failure in the harness
            print(f"[nutrition_agent] FAILED: {type(exc).__name__}: {exc}")
            return
        print(output.model_dump_json(indent=2))

    asyncio.run(_main())
