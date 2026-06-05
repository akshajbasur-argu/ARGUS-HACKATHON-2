"""Macros Calculator Agent — precise caloric/macro/micronutrient targets.

This is a *computation* agent, not a research agent. Every number is derived in
Python from established formulae (Mifflin-St Jeor BMR -> activity TDEE ->
goal-adjusted target -> macro split), because LLM arithmetic is non-deterministic
and unsafe for a medical-adjacent product. The model is used only to phrase the
human-readable verdict/reasoning, and never to produce or alter a number; if no
API key is present it falls back to a deterministic narrative.

Run standalone (API key optional — math runs without it):
    python -m features.agents.macros_agent      # from backend/
    python features/agents/macros_agent.py
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

from pydantic import BaseModel

from features.agents.base import (
    AgentError,
    SessionContext,
    call_claude,
    extract_json,
)
from schemas.agent_schemas import (
    ActivityLevel,
    AgentName,
    AgentOutput,
    PrimaryGoal,
    Sex,
    UserProfile,
)

AGENT_NAME = AgentName.MACROS
CONFIDENCE = 0.95  # formula-based, highly deterministic

# --- Formula constants ------------------------------------------------------

ACTIVITY_MULTIPLIER: dict[ActivityLevel, float] = {
    ActivityLevel.SEDENTARY: 1.2,
    ActivityLevel.LIGHTLY_ACTIVE: 1.375,
    ActivityLevel.ACTIVE: 1.55,
    ActivityLevel.VERY_ACTIVE: 1.725,
}

# Goal -> (kcal adjustment, protein g per kg bodyweight)
GOAL_CALORIE_ADJUSTMENT: dict[PrimaryGoal, int] = {
    PrimaryGoal.WEIGHT_LOSS: -500,
    PrimaryGoal.MUSCLE_GAIN: +300,
    PrimaryGoal.ENDURANCE: +100,
    PrimaryGoal.GENERAL_HEALTH: 0,
}
GOAL_PROTEIN_PER_KG: dict[PrimaryGoal, float] = {
    PrimaryGoal.WEIGHT_LOSS: 1.8,
    PrimaryGoal.MUSCLE_GAIN: 2.0,
    PrimaryGoal.ENDURANCE: 1.6,
    PrimaryGoal.GENERAL_HEALTH: 1.4,
}

# Mifflin-St Jeor sex constant
SEX_CONSTANT: dict[Sex, float] = {Sex.MALE: 5.0, Sex.FEMALE: -161.0, Sex.OTHER: -78.0}

DIABETIC_CARB_PCT_CAP = 0.40
DEFAULT_FAT_PCT = 0.25
KCAL_PER_G = {"protein": 4, "carbs": 4, "fat": 9}


MACROS_SYSTEM_PROMPT = """\
You are a precision sports nutrition scientist and registered dietitian. You are
given a set of ALREADY-COMPUTED macronutrient targets (BMR, TDEE, target
calories, macros in grams and percentages, micronutrients) derived from the
Mifflin-St Jeor equation. The numbers are final and correct — do NOT recompute,
round, or change any value.

Your only job is to explain them. Respond with ONLY one valid JSON object, no
preamble, no markdown fences:
{
  "verdict": "<one concise sentence stating the daily target and macro split>",
  "reasoning": "<2-4 sentences explaining why these targets fit the user's
                 metrics, goal, and any medical constraint such as a diabetic
                 carbohydrate cap>"
}
"""


# --- Validation model -------------------------------------------------------


class _MacroSplit(BaseModel):
    protein: float
    carbs: float
    fat: float


class _Micros(BaseModel):
    fibre_g: float
    sodium_mg: float
    calcium_mg: float
    iron_mg: float


class _MacrosData(BaseModel):
    bmr: float
    tdee: float
    target_calories: float
    macros_g: _MacroSplit
    macros_pct: _MacroSplit
    micros: _Micros
    water_ml: float
    formula_used: str
    calculation_steps: list[str]


# --- Pure computation -------------------------------------------------------


def _is_diabetic(profile: UserProfile) -> bool:
    return any("diabet" in c.lower() for c in profile.medical_conditions)


def _has(profile: UserProfile, needle: str) -> bool:
    return any(needle in c.lower() for c in profile.medical_conditions)


def compute_macros(profile: UserProfile) -> tuple[_MacrosData, list[str]]:
    """Deterministically compute all targets. Returns (data, flags)."""
    flags: list[str] = []
    steps: list[str] = []

    w, h, age = profile.weight_kg, profile.height_cm, profile.age
    sex_const = SEX_CONSTANT[profile.sex]

    # 1) BMR — Mifflin-St Jeor
    bmr = 10 * w + 6.25 * h - 5 * age + sex_const
    bmr = round(bmr, 1)
    sex_term = f"+ {sex_const:g}" if sex_const >= 0 else f"− {abs(sex_const):g}"
    steps.append(
        f"BMR (Mifflin-St Jeor, {profile.sex.value}) = "
        f"10×{w:g} + 6.25×{h:g} − 5×{age} {sex_term} = {bmr} kcal"
    )

    # 2) TDEE — activity multiplier
    mult = ACTIVITY_MULTIPLIER[profile.activity_level]
    tdee = round(bmr * mult, 1)
    steps.append(
        f"TDEE = BMR × {mult} ({profile.activity_level.value}) = {tdee} kcal"
    )

    # 3) Goal-adjusted target
    adj = GOAL_CALORIE_ADJUSTMENT[profile.primary_goal]
    target = round(tdee + adj, 1)
    sign = f"+ {adj}" if adj >= 0 else f"− {abs(adj)}"
    steps.append(
        f"Target = TDEE {sign} ({profile.primary_goal.value}) = {target} kcal"
    )

    # 4) Protein from bodyweight
    g_per_kg = GOAL_PROTEIN_PER_KG[profile.primary_goal]
    protein_g = round(g_per_kg * w)
    steps.append(
        f"Protein = {g_per_kg} g/kg × {w:g} kg = {protein_g} g "
        f"({protein_g * KCAL_PER_G['protein']} kcal)"
    )

    # 5) Fat at 25% of calories
    fat_g = round(DEFAULT_FAT_PCT * target / KCAL_PER_G["fat"])
    steps.append(
        f"Fat = {int(DEFAULT_FAT_PCT * 100)}% of {target} kcal / 9 = {fat_g} g"
    )

    # 6) Carbs fill the remainder
    carb_kcal = target - protein_g * KCAL_PER_G["protein"] - fat_g * KCAL_PER_G["fat"]
    carbs_g = round(max(carb_kcal, 0) / KCAL_PER_G["carbs"])
    steps.append(
        f"Carbs = remaining {round(carb_kcal)} kcal / 4 = {carbs_g} g"
    )

    # 7) Diabetic carbohydrate cap (<= 40% of calories), redistribute to fat
    if _is_diabetic(profile):
        max_carbs_g = round(DIABETIC_CARB_PCT_CAP * target / KCAL_PER_G["carbs"])
        if carbs_g > max_carbs_g:
            freed_kcal = (carbs_g - max_carbs_g) * KCAL_PER_G["carbs"]
            carbs_g = max_carbs_g
            fat_g += round(freed_kcal / KCAL_PER_G["fat"])
            flags.append("carbs_capped_40pct_diabetic")
            steps.append(
                f"Diabetic flag: carbs capped at {int(DIABETIC_CARB_PCT_CAP * 100)}% "
                f"→ {carbs_g} g; surplus reallocated to fat → {fat_g} g"
            )

    # 8) Percentages (of target calories)
    def pct(grams: float, macro: str) -> float:
        return round(grams * KCAL_PER_G[macro] / target * 100) if target else 0.0

    macros_pct = _MacroSplit(
        protein=pct(protein_g, "protein"),
        carbs=pct(carbs_g, "carbs"),
        fat=pct(fat_g, "fat"),
    )

    # 9) Micronutrients (guideline-based, adjusted for sex/age/conditions)
    fibre_g = round(14 * target / 1000, 1)  # 14 g per 1000 kcal
    sodium_mg = 1500.0 if _has(profile, "hypertension") else 2300.0
    if sodium_mg == 1500.0:
        flags.append("sodium_restricted_1500mg_hypertension")
    calcium_mg = 1200.0 if age >= 50 else 1000.0
    iron_mg = {Sex.MALE: 8.0, Sex.FEMALE: 18.0, Sex.OTHER: 11.0}[profile.sex]
    water_ml = round(35 * w)  # 35 ml per kg bodyweight

    data = _MacrosData(
        bmr=bmr,
        tdee=tdee,
        target_calories=target,
        macros_g=_MacroSplit(protein=protein_g, carbs=carbs_g, fat=fat_g),
        macros_pct=macros_pct,
        micros=_Micros(
            fibre_g=fibre_g,
            sodium_mg=sodium_mg,
            calcium_mg=calcium_mg,
            iron_mg=iron_mg,
        ),
        water_ml=water_ml,
        formula_used="mifflin_st_jeor",
        calculation_steps=steps,
    )
    return data, flags


def _deterministic_narrative(data: _MacrosData, profile: UserProfile) -> tuple[str, str]:
    g = data.macros_g
    verdict = (
        f"{int(data.target_calories)} kcal/day — protein {int(g.protein)}g, "
        f"carbs {int(g.carbs)}g, fat {int(g.fat)}g"
    )
    reasoning = (
        f"Mifflin-St Jeor BMR of {data.bmr} kcal scaled to a TDEE of {data.tdee} "
        f"kcal by the {profile.activity_level.value} multiplier, then adjusted for "
        f"{profile.primary_goal.value}. Protein is set from bodyweight to preserve "
        f"lean mass; fat at ~25% of calories; carbohydrates fill the remainder."
    )
    if _is_diabetic(profile):
        reasoning += " Carbohydrates are capped at 40% of calories for diabetes."
    return verdict, reasoning


async def _narrate(sub_task: str, data: _MacrosData, profile: UserProfile) -> tuple[str, str]:
    """Best-effort LLM narration; deterministic fallback on any failure/no key."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return _deterministic_narrative(data, profile)
    try:
        user = (
            f"Sub-task: {sub_task}\n\nComputed targets (final, do not change):\n"
            f"{data.model_dump_json(indent=2)}"
        )
        raw = await call_claude(
            MACROS_SYSTEM_PROMPT, user, temperature=0.2, max_tokens=512, prefill="{"
        )
        parsed = extract_json(raw)
        verdict = str(parsed.get("verdict", "")).strip()
        reasoning = str(parsed.get("reasoning", "")).strip()
        if verdict and reasoning:
            return verdict, reasoning
    except AgentError:
        pass
    return _deterministic_narrative(data, profile)


# --- Public entry point -----------------------------------------------------


async def run(
    sub_task: str,
    profile: UserProfile,
    *,
    peer_context: dict | None = None,
    round: int = 1,
    session_context: SessionContext | None = None,
) -> AgentOutput:
    """Compute precise macro targets and return a validated AgentOutput."""
    if session_context:
        sub_task += session_context.revision_block(AGENT_NAME.value)
    data, flags = compute_macros(profile)
    verdict, reasoning = await _narrate(sub_task, data, profile)

    return AgentOutput(
        agent_name=AGENT_NAME.value,
        verdict=verdict,
        confidence=CONFIDENCE,
        reasoning=reasoning,
        flags=flags,
        data=data.model_dump(),
        round=round,
    )


# ---------------------------------------------------------------------------
# Standalone test harness
# ---------------------------------------------------------------------------

if __name__ == "__main__":
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
        "You are the Macros Agent. Male, 34y, 88kg, 175cm, lightly_active, "
        "goal: weight_loss, medical: type_2_diabetes. Calculate precise macro targets."
    )

    async def _main() -> None:
        output = await run(demo_sub_task, demo_profile)
        print(output.model_dump_json(indent=2))

    asyncio.run(_main())
