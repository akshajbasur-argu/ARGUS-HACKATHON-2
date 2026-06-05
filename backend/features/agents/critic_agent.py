"""Critic Agent — cross-agent consistency / QA, the last line of defence.

Reads all five specialist outputs and detects contradictions. The spec's flag
rules are all numerical comparisons, so they are computed DETERMINISTICALLY in
Python: this makes detection reproducible and, crucially, lets the debate loop
terminate predictably (a loop driven by non-deterministic LLM rejections could
oscillate forever). The LLM is used only to phrase critique_summary, with a
deterministic fallback.

The machine-readable `revision_requests` dict (agent_name -> instruction) is the
re-routing map the debate loop iterates over directly.
"""

from __future__ import annotations

# --- standalone bootstrap: put backend/ on sys.path when run as a script ------
if __name__ == "__main__" and __package__ in (None, ""):
    import pathlib
    import sys

    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
# ------------------------------------------------------------------------------

import asyncio
import os
from typing import Any

from pydantic import BaseModel

from features.agents.base import AgentError, call_claude, extract_json
from schemas.agent_schemas import AgentName, AgentOutput, UserProfile

AGENT_NAME = AgentName.CRITIC

CALORIE_TOLERANCE = 100  # nutrition vs macros, ±kcal
MAX_SAFE_DAILY_DEFICIT = 1000  # diet + exercise combined, kcal/day
CONTRADICTION_PENALTY = 0.15  # consistency_score decrement per contradiction

SPECIALISTS = ("nutrition", "macros", "fitness", "risk", "budget")


CRITIC_SYSTEM_PROMPT = """\
You are a medical-grade AI quality assurance reviewer. You receive the outputs of
5 specialist health agents and must identify logical contradictions, numerical
inconsistencies, unsafe combinations, and budget-plan mismatches. You are the
last line of defence before a health plan is delivered to a real human.

You will be given the agent outputs and a list of contradictions already detected
by deterministic checks. Write a concise, conservative QA summary for a clinician
reviewer. Respond with ONLY one valid JSON object, no preamble:
{
  "critique_summary": "<3-5 sentence QA summary referencing the key issues>"
}
"""


# --- Output schema ----------------------------------------------------------


class _Contradiction(BaseModel):
    agents_involved: list[str]
    field_a: str
    value_a: str
    field_b: str
    value_b: str
    resolution: str


class _CriticData(BaseModel):
    consistency_score: float
    contradictions: list[_Contradiction]
    approved_agents: list[str]
    rejected_agents: list[str]
    revision_requests: dict[str, str]
    final_recommendation_safe: bool
    overall_quality_score: float
    critique_summary: str


# --- Helpers ----------------------------------------------------------------


def _data(outputs: dict[str, AgentOutput], name: str) -> dict[str, Any]:
    out = outputs.get(name)
    return dict(out.data) if out is not None else {}


def _daily_burn(fitness: dict[str, Any]) -> float | None:
    """Average daily exercise burn from the fitness weekly_plan."""
    plan = fitness.get("weekly_plan")
    if not isinstance(plan, list) or not plan:
        return None
    total = sum(float(d.get("calories_burned_est", 0)) for d in plan)
    return total / 7.0


def _run_checks(
    outputs: dict[str, AgentOutput],
) -> tuple[list[_Contradiction], dict[str, str], set[str], bool]:
    """Deterministic contradiction detection. Returns
    (contradictions, revision_requests, rejected_agents, has_critical)."""
    contradictions: list[_Contradiction] = []
    revisions: dict[str, str] = {}
    rejected: set[str] = set()
    has_critical = False

    nutri = _data(outputs, "nutrition")
    macros = _data(outputs, "macros")
    fitness = _data(outputs, "fitness")
    risk = _data(outputs, "risk")
    budget = _data(outputs, "budget")

    # Rule 1: nutrition daily_calories vs macros target_calories (±100 kcal)
    if "daily_calories" in nutri and "target_calories" in macros:
        a, b = float(nutri["daily_calories"]), float(macros["target_calories"])
        if abs(a - b) > CALORIE_TOLERANCE:
            contradictions.append(
                _Contradiction(
                    agents_involved=["nutrition", "macros"],
                    field_a="nutrition.daily_calories",
                    value_a=str(int(a)),
                    field_b="macros.target_calories",
                    value_b=str(int(b)),
                    resolution=(
                        f"Nutrition agent must revise daily_calories to match the "
                        f"macros target of {int(b)} kcal (±{CALORIE_TOLERANCE})."
                    ),
                )
            )
            revisions["nutrition"] = (
                f"Set daily_calories to within ±{CALORIE_TOLERANCE} kcal of the macros "
                f"target {int(b)} (currently {int(a)})."
            )
            rejected.add("nutrition")

    # Rule 2: combined daily deficit (diet + exercise) > 1000 kcal
    tdee = macros.get("tdee")
    target = macros.get("target_calories")
    intake = nutri.get("daily_calories", target)
    burn = _daily_burn(fitness)
    if tdee is not None and intake is not None:
        deficit = (float(tdee) - float(intake)) + (burn or 0.0)
        if deficit > MAX_SAFE_DAILY_DEFICIT:
            contradictions.append(
                _Contradiction(
                    agents_involved=["macros", "fitness"],
                    field_a="combined_daily_deficit",
                    value_a=f"{deficit:.0f}",
                    field_b="safe_max_deficit",
                    value_b=str(MAX_SAFE_DAILY_DEFICIT),
                    resolution=(
                        "Reduce exercise volume or raise intake so the combined daily "
                        "deficit is <= 1000 kcal."
                    ),
                )
            )
            revisions["fitness"] = (
                "Reduce weekly training volume/intensity so the average daily calorie "
                "burn brings the combined deficit to <= 1000 kcal."
            )
            rejected.add("fitness")

    # Rule 3: budget total over user budget
    if budget:
        within = budget.get("within_budget")
        total = budget.get("total_weekly_cost_inr")
        ubudget = budget.get("user_budget_inr")
        over = within is False or (
            total is not None and ubudget is not None and float(total) > float(ubudget)
        )
        if over:
            contradictions.append(
                _Contradiction(
                    agents_involved=["budget"],
                    field_a="budget.total_weekly_cost_inr",
                    value_a=str(total),
                    field_b="budget.user_budget_inr",
                    value_b=str(ubudget),
                    resolution="Bring total within budget using cheaper alternatives.",
                )
            )
            revisions["budget"] = (
                "Apply cheapest_alternatives / drop non-essential items so "
                "total_weekly_cost_inr is within user_budget_inr."
            )
            rejected.add("budget")

    # Rule 4: risk says unsafe but a plan was still produced
    if risk and risk.get("safe_to_proceed") is False:
        has_critical = True
        responsible: list[str] = []
        for flag in risk.get("medical_flags", []):
            if flag.get("severity") in ("danger", "critical"):
                who = flag.get("agent_responsible")
                if who in SPECIALISTS and who != "risk":
                    revisions.setdefault(
                        who,
                        flag.get(
                            "recommendation",
                            "Address the medical risk flagged by the Risk Agent.",
                        ),
                    )
                    rejected.add(who)
                    responsible.append(who)
        contradictions.append(
            _Contradiction(
                agents_involved=["risk", *responsible],
                field_a="risk.safe_to_proceed",
                value_a="false",
                field_b="plan.delivered",
                value_b="true",
                resolution=(
                    "Risk Agent flagged the plan unsafe; revise the responsible agents "
                    "and obtain physician clearance before proceeding."
                ),
            )
        )

    return contradictions, revisions, rejected, has_critical


def _mean_confidence(outputs: dict[str, AgentOutput]) -> float:
    confs = [o.confidence for o in outputs.values()]
    return round(sum(confs) / len(confs), 3) if confs else 0.0


def _scores(n_contradictions: int, mean_conf: float) -> tuple[float, float]:
    consistency = max(0.0, 1.0 - CONTRADICTION_PENALTY * n_contradictions)
    consistency = round(consistency, 2)
    quality = round((consistency + mean_conf) / 2, 2)
    return consistency, quality


async def _summarise(
    outputs: dict[str, AgentOutput], contradictions: list[_Contradiction]
) -> str:
    deterministic = (
        f"{len(contradictions)} contradiction(s) detected across "
        f"{len(outputs)} agent outputs."
        if contradictions
        else "No cross-agent contradictions detected; outputs are mutually consistent."
    )
    if not os.environ.get("GEMINI_API_KEY"):
        return deterministic
    try:
        payload = {
            "agent_outputs": {n: o.data for n, o in outputs.items()},
            "detected_contradictions": [c.model_dump() for c in contradictions],
        }
        raw = await call_claude(
            CRITIC_SYSTEM_PROMPT,
            f"Review these and summarise:\n{payload}",
            temperature=0.2,
            max_tokens=512,
            prefill="{",
        )
        summary = str(extract_json(raw).get("critique_summary", "")).strip()
        return summary or deterministic
    except AgentError:
        return deterministic


# --- Public entry point -----------------------------------------------------


async def review(
    agent_outputs: dict[str, AgentOutput],
    profile: UserProfile,
    *,
    round: int = 1,
) -> AgentOutput:
    """Run QA over all specialist outputs and return a critic AgentOutput."""
    present = [n for n in SPECIALISTS if n in agent_outputs]

    contradictions, revisions, rejected, has_critical = _run_checks(agent_outputs)
    mean_conf = _mean_confidence(agent_outputs)
    consistency, quality = _scores(len(contradictions), mean_conf)

    risk_safe = agent_outputs.get("risk")
    risk_safe_val = (
        bool(risk_safe.data.get("safe_to_proceed", True)) if risk_safe else True
    )
    final_safe = risk_safe_val and not has_critical

    summary = await _summarise(agent_outputs, contradictions)

    rejected_list = sorted(rejected)
    approved_list = [n for n in present if n not in rejected]

    data = _CriticData(
        consistency_score=consistency,
        contradictions=contradictions,
        approved_agents=approved_list,
        rejected_agents=rejected_list,
        revision_requests=revisions,
        final_recommendation_safe=final_safe,
        overall_quality_score=quality,
        critique_summary=summary,
    )

    verdict = (
        f"QA {'PASS' if not rejected_list else 'REVISE'}: "
        f"consistency {consistency}, quality {quality}, "
        f"{len(contradictions)} contradiction(s)"
    )

    return AgentOutput(
        agent_name=AGENT_NAME.value,
        verdict=verdict,
        confidence=mean_conf,
        reasoning=summary,
        flags=[f"reject:{a}" for a in rejected_list],
        data=data.model_dump(),
        round=round,
    )


# Convenience alias matching the other agents' verb.
async def run(
    agent_outputs: dict[str, AgentOutput],
    profile: UserProfile,
    *,
    round: int = 1,
) -> AgentOutput:
    return await review(agent_outputs, profile, round=round)


# ---------------------------------------------------------------------------
# Standalone test harness
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from schemas.agent_schemas import ActivityLevel, PrimaryGoal, Sex

    profile = UserProfile(
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
    sample = {
        "nutrition": AgentOutput(
            agent_name="nutrition", verdict="", confidence=0.85, reasoning="",
            data={"daily_calories": 1800},
        ),
        "macros": AgentOutput(
            agent_name="macros", verdict="", confidence=0.95, reasoning="",
            data={"tdee": 2487, "target_calories": 2104},
        ),
    }

    async def _main() -> None:
        out = await review(sample, profile)
        print(out.model_dump_json(indent=2))

    asyncio.run(_main())
