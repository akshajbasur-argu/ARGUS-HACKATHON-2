"""Budget Agent — cost feasibility of the plan against the weekly budget.

The LLM supplies the priced line items (it knows the Indian market); Python does
all the arithmetic — category subtotals, total, surplus/deficit, within_budget —
from those items, and takes the budget from the profile (authoritative). This
guarantees the aggregates can never contradict the breakdown, which is the
numerical signal the Critic uses to check budget consistency.

Run standalone (needs GEMINI_API_KEY):
    python -m features.agents.budget_agent      # from backend/
    python features/agents/budget_agent.py
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

from pydantic import BaseModel, ValidationError

from features.agents.base import (
    AgentParseError,
    SessionContext,
    call_claude,
    extract_json,
)
from features.agents.research import gemini_grounded_research, grounding_block
from schemas.agent_schemas import AgentName, AgentOutput, UserProfile

AGENT_NAME = AgentName.BUDGET
CONFIDENCE = 0.75  # prices vary by city/season — acknowledge uncertainty

_GYM_KEYWORDS = ("gym", "member", "trainer", "fitness")
_SUPPLEMENT_KEYWORDS = (
    "supplement",
    "protein",
    "vitamin",
    "whey",
    "omega",
    "creatine",
    "b12",
)

_GENERIC_OPTIMISATIONS = [
    "Replace branded items with local/generic equivalents.",
    "Buy staples (dal, rice, oats) in bulk to lower per-kg cost.",
    "Defer non-essential supplements until the budget allows.",
    "Choose seasonal local vegetables over imported produce.",
    "Use home/bodyweight workouts to eliminate gym membership cost.",
]


BUDGET_SYSTEM_PROMPT = """\
You are a certified financial planner specialising in consumer health economics
in the Indian market. You price groceries, gym memberships, and supplements for
Indian Tier-1 and Tier-2 cities.

PRICING SOURCE: a WEB RESEARCH CONTEXT block with live Indian market prices is
appended below. Use those current prices for every line item. Only when a
specific item is not covered there, fall back to a realistic current
Indian-market estimate — never invent prices that contradict the live data.

Respond with ONLY one valid JSON object — no preamble, no markdown fences:
{
  "verdict": "<one concise sentence on affordability>",
  "reasoning": "<2-4 sentences explaining the cost picture>",
  "flags": ["<short strings, or empty>"],
  "data": {
    "cost_breakdown": [
      {"category": "food|gym|supplement",
       "item": "<str>", "weekly_cost_inr": <number>, "is_essential": <bool>}
    ],
    "budget_optimisations": ["<suggestion>", ...],
    "cheapest_alternatives": [
      {"original": "<str>", "alternative": "<str>", "saving_inr": <number>}
    ]
  }
}

Rules:
- Provide per-item WEEKLY costs (prorate monthly costs by dividing by ~4.3).
- Mark supplements is_essential=false unless a deficiency was flagged.
- If the plan is over budget, give at least 3 budget_optimisations.
Do NOT compute totals — the system computes them from your line items.
"""


# --- Validation models ------------------------------------------------------


class _CostItem(BaseModel):
    category: str
    item: str
    weekly_cost_inr: float
    is_essential: bool = False


class _Alternative(BaseModel):
    original: str
    alternative: str
    saving_inr: float


class _BudgetCore(BaseModel):
    """What the LLM supplies; aggregates are computed in Python."""

    cost_breakdown: list[_CostItem]
    budget_optimisations: list[str]
    cheapest_alternatives: list[_Alternative]


# --- Helpers ----------------------------------------------------------------


def _research_query(profile: UserProfile) -> str:
    """Query for live Indian grocery/gym/supplement prices to ground costs."""
    diet = profile.dietary_restrictions[0].lower() if profile.dietary_restrictions else ""
    parts = [
        "current India grocery prices per kg INR",
        f"{diet} foods" if diet else "staple foods dal rice vegetables",
        "milk eggs paneer fruits",
    ]
    if profile.gym_access:
        parts.append("gym membership monthly cost India")
    parts.append("protein supplement price India")
    return " ".join(parts)


def _classify(category: str) -> str:
    c = category.lower()
    if any(k in c for k in _GYM_KEYWORDS):
        return "gym"
    if any(k in c for k in _SUPPLEMENT_KEYWORDS):
        return "supplement"
    return "food"  # default: groceries / misc


def _risk_flagged_deficiency(peer_context: dict | None) -> bool:
    if not peer_context:
        return False
    return "deficien" in json.dumps(peer_context).lower()


def _compute_budget(
    core: _BudgetCore, profile: UserProfile, peer_context: dict | None
) -> tuple[dict, list[str]]:
    """Deterministically aggregate costs. Returns (data, top_level_flags)."""
    essential_supplements_ok = _risk_flagged_deficiency(peer_context)

    buckets = {"food": 0.0, "gym": 0.0, "supplement": 0.0}
    clean_items: list[dict] = []
    for it in core.cost_breakdown:
        bucket = _classify(it.category)
        # No gym access -> no membership cost; drop gym line items.
        if bucket == "gym" and not profile.gym_access:
            continue
        is_essential = it.is_essential
        if bucket == "supplement" and not essential_supplements_ok:
            is_essential = False
        cost = round(it.weekly_cost_inr, 2)
        buckets[bucket] += cost
        clean_items.append(
            {
                "category": bucket,
                "item": it.item,
                "weekly_cost_inr": cost,
                "is_essential": is_essential,
            }
        )

    food = round(buckets["food"], 2)
    gym = round(buckets["gym"], 2)
    supp = round(buckets["supplement"], 2)
    total = round(food + gym + supp, 2)
    budget = round(profile.weekly_budget_inr, 2)
    surplus = round(budget - total, 2)
    within = surplus >= 0

    optimisations = list(core.budget_optimisations)
    if not within:
        # Invariant: >=3 optimisations when over budget. Pad with generics.
        for opt in _GENERIC_OPTIMISATIONS:
            if len(optimisations) >= 3:
                break
            if opt not in optimisations:
                optimisations.append(opt)

    data = {
        "weekly_food_cost_inr": food,
        "weekly_gym_cost_inr": gym,
        "weekly_supplement_cost_inr": supp,
        "total_weekly_cost_inr": total,
        "user_budget_inr": budget,
        "budget_surplus_deficit_inr": surplus,
        "within_budget": within,
        "cost_breakdown": clean_items,
        "budget_optimisations": optimisations,
        "cheapest_alternatives": [a.model_dump() for a in core.cheapest_alternatives],
    }
    flags = [] if within else [f"over_budget_by_inr_{abs(surplus):g}"]
    return data, flags


# --- Public entry point -----------------------------------------------------


async def run(
    sub_task: str,
    profile: UserProfile,
    *,
    peer_context: dict | None = None,
    round: int = 1,
    session_context: SessionContext | None = None,
) -> AgentOutput:
    """Produce a validated budget AgentOutput with deterministic totals."""
    user_message = sub_task
    if peer_context:
        user_message += f"\n\nPeer plan to cost (round {round}):\n{peer_context}"
    if session_context:
        user_message += session_context.revision_block(AGENT_NAME.value)

    # Ground real INR prices live before the LLM emits the cost_breakdown.
    research = await gemini_grounded_research(_research_query(profile))
    system_prompt = BUDGET_SYSTEM_PROMPT + grounding_block(
        research["summary"], research["sources"]
    )

    raw = await call_claude(
        system_prompt,
        user_message,
        temperature=0.3,
        max_tokens=2048,
        prefill="{",
    )
    parsed = extract_json(raw)

    try:
        core = _BudgetCore.model_validate(parsed.get("data", {}))
    except ValidationError as exc:
        raise AgentParseError(f"Budget data failed validation: {exc}") from exc

    data, flags = _compute_budget(core, profile, peer_context)
    data["sources"] = research["sources"]
    flags += [str(f) for f in parsed.get("flags", []) if str(f).strip()]

    verdict = str(parsed.get("verdict", "")).strip()
    if not verdict:
        verdict = (
            f"INR {data['total_weekly_cost_inr']:g}/week vs INR {data['user_budget_inr']:g} "
            + (
                "— within budget"
                if data["within_budget"]
                else f"— over by INR {abs(data['budget_surplus_deficit_inr']):g}"
            )
        )

    return AgentOutput(
        agent_name=AGENT_NAME.value,
        verdict=verdict,
        confidence=CONFIDENCE,
        reasoning=str(parsed.get("reasoning", "")).strip(),
        flags=flags,
        data=data,
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
        "You are the Budget Agent. Cost a vegetarian weight-loss plan with gym "
        "access against a weekly budget of INR 2500 for a Tier-1 city."
    )

    async def _main() -> None:
        try:
            output = await run(demo_sub_task, demo_profile)
        except Exception as exc:  # noqa: BLE001 — surface any failure in the harness
            print(f"[budget_agent] FAILED: {type(exc).__name__}: {exc}")
            return
        print(output.model_dump_json(indent=2))

    asyncio.run(_main())
