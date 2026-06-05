"""Fitness Agent — personalised 7-day exercise programme.

Workout *content* is LLM-generated (a certified-trainer persona), but the hard
safety/structure rules are enforced in Python so they can't be skipped by the
model: exactly 7 days, bodyweight-only when there's no gym, a cardiac HR cap
flag for heart/BP conditions, and weekly_stats recomputed from the actual plan
(guaranteeing they agree — the Critic relies on that).

Run standalone (needs ANTHROPIC_API_KEY):
    python -m features.agents.fitness_agent      # from backend/
    python features/agents/fitness_agent.py
"""

from __future__ import annotations

# --- standalone bootstrap: put backend/ on sys.path when run as a script ------
if __name__ == "__main__" and __package__ in (None, ""):
    import pathlib
    import sys

    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
# ------------------------------------------------------------------------------

import asyncio
from typing import Literal

from pydantic import BaseModel, ValidationError

from features.agents.base import (
    AgentParseError,
    SessionContext,
    call_claude,
    extract_json,
)
from schemas.agent_schemas import (
    AgentName,
    AgentOutput,
    PrimaryGoal,
    UserProfile,
)

AGENT_NAME = AgentName.FITNESS

DEFAULT_CONFIDENCE = 0.85
CAUTION_CONFIDENCE = 0.65  # cardiac condition present or medical_conditions > 2

SessionType = Literal["Strength", "Cardio", "HIIT", "Rest", "Flexibility"]
CARDIO_TYPES = {"Cardio", "HIIT"}
CARDIAC_CONDITIONS = ("heart_disease", "hypertension", "cardiac", "arrhythmia")

# Goal -> target weekly session split (each sums to 7 days).
GOAL_SPLIT: dict[PrimaryGoal, str] = {
    PrimaryGoal.WEIGHT_LOSS: "3 Cardio, 2 Strength, 2 Rest",
    PrimaryGoal.MUSCLE_GAIN: "4 Strength, 1 Cardio, 2 Rest",
    PrimaryGoal.ENDURANCE: "4 Cardio, 1 Strength, 2 Rest",
    PrimaryGoal.GENERAL_HEALTH: "2 Strength, 2 Cardio, 1 Flexibility, 2 Rest",
}


FITNESS_SYSTEM_PROMPT = """\
You are a certified personal trainer (NASM-CPT) and exercise physiologist with
10 years of clinical experience. You design safe, evidence-based, progressive
weekly workout programmes tailored to the individual.

You receive a sub-task describing one user plus a set of HARD CONSTRAINTS. Obey
every hard constraint exactly. General principles:
- Match volume and modality to the stated goal and fitness level.
- Never prescribe gym equipment when the user has no gym access.
- For cardiovascular or blood-pressure conditions, keep intensity moderate and
  say so in the session notes.
- Every training session's "notes" must mention a 5-minute warmup and a
  5-minute cooldown.

Respond with ONLY one valid JSON object — no preamble, no markdown fences:
{
  "verdict": "<one concise sentence summarising the weekly programme>",
  "reasoning": "<2-4 sentences justifying the structure from the profile>",
  "flags": ["<short concern strings, or empty>"],
  "data": {
    "weekly_plan": [
      {
        "day": "<Monday..Sunday>",
        "type": "Strength|Cardio|HIIT|Rest|Flexibility",
        "duration_min": <int>,
        "exercises": [
          {"name": "<str>", "sets": <int>,
           "reps_or_duration": "<e.g. '12 reps' or '30 sec'>", "rest_sec": <int>}
        ],
        "calories_burned_est": <int>,
        "notes": "<str incl. warmup/cooldown>"
      }
    ],
    "progression_plan": "<4-week progression description>",
    "equipment_needed": ["<item>", ...]
  }
}

Hard requirements:
- weekly_plan MUST contain exactly 7 entries, one per day Monday..Sunday.
- Rest days use type "Rest", duration_min 0, and an empty exercises list.
"""


# --- Validation models ------------------------------------------------------


class _Exercise(BaseModel):
    name: str
    sets: int
    reps_or_duration: str
    rest_sec: int


class _DayPlan(BaseModel):
    day: str
    type: SessionType
    duration_min: int
    exercises: list[_Exercise]
    calories_burned_est: int
    notes: str


class _FitnessCore(BaseModel):
    """What we require the LLM to produce (weekly_stats is computed in Python)."""

    weekly_plan: list[_DayPlan]
    progression_plan: str
    equipment_needed: list[str]


# --- Helpers ----------------------------------------------------------------


def _has(profile: UserProfile, *needles: str) -> bool:
    conds = " ".join(profile.medical_conditions).lower()
    return any(n in conds for n in needles)


def _is_cardiac(profile: UserProfile) -> bool:
    return _has(profile, *CARDIAC_CONDITIONS)


def _cardiac_hr_range(profile: UserProfile) -> tuple[int, int]:
    """60-70% of HRmax (220 - age). Kept out of run() where `round` is shadowed."""
    hr_max = 220 - profile.age
    return round(0.6 * hr_max), round(0.7 * hr_max)


def _confidence_for(profile: UserProfile) -> float:
    if _is_cardiac(profile) or len(profile.medical_conditions) > 2:
        return CAUTION_CONFIDENCE
    return DEFAULT_CONFIDENCE


def _weekly_stats(plan: list[_DayPlan]) -> dict[str, int]:
    """Recompute stats from the plan so they can never contradict it."""
    return {
        "total_sessions": sum(1 for d in plan if d.type != "Rest"),
        "rest_days": sum(1 for d in plan if d.type == "Rest"),
        "cardio_minutes": sum(d.duration_min for d in plan if d.type in CARDIO_TYPES),
        "strength_sessions": sum(1 for d in plan if d.type == "Strength"),
    }


def _build_constraints(profile: UserProfile) -> str:
    lines = [
        "- Produce exactly 7 day entries (Monday..Sunday).",
        f"- Target weekly split for {profile.primary_goal.value}: "
        f"{GOAL_SPLIT[profile.primary_goal]}.",
        "- Each training session's notes must include a 5-min warmup and 5-min cooldown.",
    ]
    if not profile.gym_access:
        lines.append(
            "- NO gym access: every exercise must be bodyweight-only "
            "(no machines, no free weights). equipment_needed must be empty/none."
        )
    if _is_cardiac(profile):
        lo, hi = _cardiac_hr_range(profile)
        lines.append(
            f"- Cardiac/BP condition: cap intensity at 60-70% HRmax ({lo}-{hi} bpm) "
            "and state this in each cardio/HIIT session's notes."
        )
    if _has(profile, "diabet"):
        lines.append(
            "- Diabetic: add a note to check blood glucose before and after exercise."
        )
    return "\n".join(lines)


# --- Public entry point -----------------------------------------------------


async def run(
    sub_task: str,
    profile: UserProfile,
    *,
    peer_context: dict | None = None,
    round: int = 1,
    session_context: SessionContext | None = None,
) -> AgentOutput:
    """Produce a validated 7-day fitness AgentOutput."""
    user_message = f"{sub_task}\n\nHARD CONSTRAINTS:\n{_build_constraints(profile)}"
    if peer_context:
        user_message += f"\n\nPeer context (round {round}); reconcile conflicts:\n{peer_context}"
    if session_context:
        user_message += session_context.revision_block(AGENT_NAME.value)

    raw = await call_claude(
        FITNESS_SYSTEM_PROMPT,
        user_message,
        temperature=0.5,
        max_tokens=3072,
        prefill="{",
    )
    parsed = extract_json(raw)

    try:
        core = _FitnessCore.model_validate(parsed.get("data", {}))
    except ValidationError as exc:
        raise AgentParseError(f"Fitness data failed validation: {exc}") from exc

    if len(core.weekly_plan) != 7:
        raise AgentParseError(
            f"weekly_plan must have exactly 7 days, got {len(core.weekly_plan)}"
        )

    flags: list[str] = [str(f) for f in parsed.get("flags", []) if str(f).strip()]

    # Deterministic safety overrides / flags.
    equipment = core.equipment_needed
    if not profile.gym_access:
        equipment = ["Bodyweight only (no equipment)"]
        flags.append("home_workout_bodyweight_only")
    if _is_cardiac(profile):
        lo, hi = _cardiac_hr_range(profile)
        flags.append(f"cardiac_caution: intensity capped at 60-70% HRmax ({lo}-{hi} bpm)")
    if _has(profile, "diabet"):
        flags.append("diabetic: monitor blood glucose pre/post exercise")

    data = {
        "weekly_plan": [d.model_dump() for d in core.weekly_plan],
        "weekly_stats": _weekly_stats(core.weekly_plan),
        "progression_plan": core.progression_plan,
        "equipment_needed": equipment,
    }

    return AgentOutput(
        agent_name=AGENT_NAME.value,
        verdict=str(parsed.get("verdict", "")).strip() or "Weekly programme generated",
        confidence=_confidence_for(profile),
        reasoning=str(parsed.get("reasoning", "")).strip(),
        flags=flags,
        data=data,
        round=round,
    )


# ---------------------------------------------------------------------------
# Standalone test harness
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from schemas.agent_schemas import ActivityLevel, Sex

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
        "You are the Fitness Agent. Male, 34y, 88kg, 175cm, lightly_active, "
        "goal: weight_loss, medical: type_2_diabetes, gym_access: true. "
        "Design a 7-day weekly workout programme."
    )

    async def _main() -> None:
        try:
            output = await run(demo_sub_task, demo_profile)
        except Exception as exc:  # noqa: BLE001 — surface any failure in the harness
            print(f"[fitness_agent] FAILED: {type(exc).__name__}: {exc}")
            return
        print(output.model_dump_json(indent=2))

    asyncio.run(_main())
