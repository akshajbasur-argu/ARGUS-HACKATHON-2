"""Risk Agent (Medical) — the system's safety layer.

Design principle: safety must not depend on the LLM being right. The model does
clinical reasoning over the profile and peer outputs, but Python enforces the
non-negotiable invariants:

  * a deterministic RISK FLOOR from the conditions, so the layer can never
    under-rate risk even if the model is too lenient;
  * overall_risk_level is also raised to the worst individual flag;
  * critical  => safe_to_proceed = False AND requires_physician_clearance = True;
  * at least one emergency sign is always present;
  * a deterministic baseline assessment is used when there is no API key or the
    call fails — the safety layer never hard-fails.

Run standalone (API key optional — degrades to baseline):
    python -m features.agents.risk_agent      # from backend/
    python features/agents/risk_agent.py
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
from typing import Literal

from pydantic import BaseModel, ValidationError

from features.agents.base import (
    AgentError,
    SessionContext,
    call_claude,
    extract_json,
)
from schemas.agent_schemas import AgentName, AgentOutput, UserProfile

AGENT_NAME = AgentName.RISK

CONFIDENCE_KNOWN = 0.90  # all conditions recognised
CONFIDENCE_UNUSUAL = 0.70  # at least one unrecognised condition

RiskLevelStr = Literal["low", "medium", "high", "critical"]
SeverityStr = Literal["info", "warning", "danger", "critical"]

_RISK_ORDER: dict[str, int] = {"low": 0, "medium": 1, "high": 2, "critical": 3}
_SEVERITY_TO_RISK: dict[str, str] = {
    "info": "low",
    "warning": "medium",
    "danger": "high",
    "critical": "critical",
}

# Substring -> deterministic risk floor for that condition.
_CONDITION_FLOOR: dict[str, str] = {
    "heart_disease": "high",
    "cardiac": "high",
    "arrhythmia": "high",
    "stroke": "high",
    "eating_disorder": "high",
    "recent_surgery": "high",
    "diabet": "medium",
    "hypertension": "medium",
    "kidney": "medium",
    "liver": "medium",
    "pregnan": "medium",
}
_KNOWN_SUBSTRINGS = tuple(_CONDITION_FLOOR.keys())


RISK_SYSTEM_PROMPT = """\
You are a board-certified internal medicine physician and preventive health
specialist. Your primary duty is patient safety. You must flag any medically
unsafe recommendation with clinical evidence. Be conservative. When in doubt,
flag.

You receive a sub-task describing the user, and (during the critique loop) the
outputs of peer agents (nutrition, macros, fitness, budget). Review them for
contraindications and harm.

Always check these known risky combinations:
- diabetes + very-low-carb -> hypoglycaemia risk
- hypertension + high-sodium foods -> danger
- heart disease + HIIT / maximal intensity -> danger
- severe obesity + high-impact exercise -> warning
- any condition + supplement -> check interaction

Respond with ONLY one valid JSON object — no preamble, no markdown fences:
{
  "verdict": "<one concise sentence on overall safety>",
  "reasoning": "<2-4 sentences of clinical justification>",
  "flags": ["<short summary strings, or empty>"],
  "data": {
    "overall_risk_level": "low|medium|high|critical",
    "medical_flags": [
      {
        "flag_id": "RF-001",
        "severity": "info|warning|danger|critical",
        "agent_responsible": "<nutrition|macros|fitness|budget|profile>",
        "description": "<what is unsafe and why>",
        "recommendation": "<what to do instead>",
        "icd_10_code": "<code or empty>"
      }
    ],
    "safe_to_proceed": <bool>,
    "requires_physician_clearance": <bool>,
    "contraindicated_exercises": ["<str>", ...],
    "contraindicated_foods": ["<str>", ...],
    "drug_interaction_warnings": ["<str>", ...],
    "emergency_signs": ["<symptom to watch for>", ...]
  }
}

Rules:
- If overall_risk_level is "critical": safe_to_proceed=false and
  requires_physician_clearance=true.
- Always include at least one emergency_signs item.
"""


# --- Validation models ------------------------------------------------------


class _MedicalFlag(BaseModel):
    flag_id: str = ""
    severity: SeverityStr
    agent_responsible: str
    description: str
    recommendation: str
    icd_10_code: str = ""


class _RiskData(BaseModel):
    overall_risk_level: RiskLevelStr
    medical_flags: list[_MedicalFlag]
    safe_to_proceed: bool
    requires_physician_clearance: bool
    contraindicated_exercises: list[str]
    contraindicated_foods: list[str]
    drug_interaction_warnings: list[str]
    emergency_signs: list[str]


# --- Helpers ----------------------------------------------------------------


def _has(profile: UserProfile, *needles: str) -> bool:
    conds = " ".join(profile.medical_conditions).lower()
    return any(n in conds for n in needles)


def _max_level(a: str, b: str) -> str:
    return a if _RISK_ORDER[a] >= _RISK_ORDER[b] else b


def _condition_floor(profile: UserProfile) -> str:
    floor = "low"
    conds = " ".join(profile.medical_conditions).lower()
    for needle, level in _CONDITION_FLOOR.items():
        if needle in conds:
            floor = _max_level(floor, level)
    return floor


def _confidence_for(profile: UserProfile) -> float:
    for cond in profile.medical_conditions:
        if not any(n in cond.lower() for n in _KNOWN_SUBSTRINGS):
            return CONFIDENCE_UNUSUAL
    return CONFIDENCE_KNOWN


def _default_emergency_signs(profile: UserProfile) -> list[str]:
    signs = ["Severe dizziness, fainting, or sudden chest pain — stop and seek care"]
    if _has(profile, "diabet"):
        signs.append(
            "Blood glucose < 70 mg/dL: shakiness, sweating, confusion (hypoglycaemia)"
        )
    if _has(profile, "heart_disease", "cardiac", "hypertension", "arrhythmia"):
        signs.append("Chest pain, severe breathlessness, or palpitations during exertion")
    return signs


def _baseline_flags(profile: UserProfile) -> list[_MedicalFlag]:
    """Deterministic condition-level flags — the safety net under the LLM."""
    flags: list[_MedicalFlag] = []
    if _has(profile, "diabet"):
        flags.append(
            _MedicalFlag(
                severity="warning",
                agent_responsible="profile",
                description="Diabetes: diet and exercise changes can cause hypoglycaemia.",
                recommendation="Monitor blood glucose around meals and workouts; keep fast-acting glucose available.",
                icd_10_code="E11.9",
            )
        )
    if _has(profile, "hypertension"):
        flags.append(
            _MedicalFlag(
                severity="warning",
                agent_responsible="profile",
                description="Hypertension: high-sodium intake and maximal-intensity exertion raise risk.",
                recommendation="Limit sodium (<1500 mg/day) and keep exercise moderate (60-70% HRmax).",
                icd_10_code="I10",
            )
        )
    if _has(profile, "heart_disease", "cardiac", "arrhythmia"):
        flags.append(
            _MedicalFlag(
                severity="danger",
                agent_responsible="profile",
                description="Cardiovascular disease: high-intensity/HIIT exercise is contraindicated without clearance.",
                recommendation="Obtain physician clearance; begin with low-intensity, monitored activity.",
                icd_10_code="I25.10",
            )
        )
    return flags


def _assign_flag_ids(flags: list[_MedicalFlag]) -> None:
    """Ensure every flag has a unique, non-blank flag_id (RF-001, ...).

    Valid, unique ids the model already supplied are preserved; blanks and
    duplicates are reassigned to the next free RF-NNN.
    """
    counter = 0
    used: set[str] = set()
    for f in flags:
        fid = f.flag_id.strip()
        if not fid or fid in used:
            counter += 1
            fid = f"RF-{counter:03d}"
            while fid in used:
                counter += 1
                fid = f"RF-{counter:03d}"
        f.flag_id = fid
        used.add(fid)


# --- Assessment sources -----------------------------------------------------


def _baseline_assessment(profile: UserProfile) -> _RiskData:
    """Fully deterministic conservative assessment (no LLM)."""
    flags = _baseline_flags(profile)
    level = _condition_floor(profile)
    for f in flags:
        level = _max_level(level, _SEVERITY_TO_RISK[f.severity])
    return _RiskData(
        overall_risk_level=level,  # type: ignore[arg-type]
        medical_flags=flags,
        safe_to_proceed=level != "critical",
        requires_physician_clearance=level in ("high", "critical"),
        contraindicated_exercises=(
            ["Maximal-intensity / HIIT without clearance"]
            if _has(profile, "heart_disease", "cardiac", "arrhythmia")
            else []
        ),
        contraindicated_foods=(
            ["High-sodium processed foods"] if _has(profile, "hypertension") else []
        ),
        drug_interaction_warnings=[],
        emergency_signs=_default_emergency_signs(profile),
    )


async def _llm_assessment(
    sub_task: str, profile: UserProfile, peer_context: dict | None
) -> tuple[_RiskData, str, str]:
    """Returns (risk_data, verdict, reasoning). Raises AgentError on failure."""
    user = sub_task
    if peer_context:
        user += f"\n\nPeer agent outputs to review for contraindications:\n{peer_context}"
    raw = await call_claude(
        RISK_SYSTEM_PROMPT, user, temperature=0.2, max_tokens=2048, prefill="{"
    )
    parsed = extract_json(raw)
    try:
        data = _RiskData.model_validate(parsed.get("data", {}))
    except ValidationError as exc:
        raise AgentError(f"Risk data failed validation: {exc}") from exc
    return (
        data,
        str(parsed.get("verdict", "")).strip(),
        str(parsed.get("reasoning", "")).strip(),
    )


# --- Invariant enforcement --------------------------------------------------


def _enforce_invariants(data: _RiskData, profile: UserProfile) -> _RiskData:
    # Merge a deterministic baseline so serious conditions are never silently
    # dropped, without duplicating ICD codes the model already produced.
    existing_icds = {f.icd_10_code for f in data.medical_flags if f.icd_10_code}
    for bf in _baseline_flags(profile):
        if bf.icd_10_code and bf.icd_10_code in existing_icds:
            continue
        data.medical_flags.append(bf)

    _assign_flag_ids(data.medical_flags)

    # Risk floor: max of model level, condition floor, and worst flag severity.
    level = _max_level(data.overall_risk_level, _condition_floor(profile))
    for f in data.medical_flags:
        level = _max_level(level, _SEVERITY_TO_RISK[f.severity])
    data.overall_risk_level = level  # type: ignore[assignment]

    # Hard safety rule for critical; never upgrade the model toward "safe".
    if level == "critical":
        data.safe_to_proceed = False
        data.requires_physician_clearance = True
    else:
        data.requires_physician_clearance = (
            data.requires_physician_clearance or level == "high"
        )

    if not data.emergency_signs:
        data.emergency_signs = _default_emergency_signs(profile)

    return data


# --- Public entry point -----------------------------------------------------


async def run(
    sub_task: str,
    profile: UserProfile,
    *,
    peer_context: dict | None = None,
    round: int = 1,
    session_context: SessionContext | None = None,
) -> AgentOutput:
    """Assess risk and return a validated AgentOutput; never hard-fails."""
    if session_context:
        sub_task += session_context.revision_block(AGENT_NAME.value)
    verdict = reasoning = ""
    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            data, verdict, reasoning = await _llm_assessment(
                sub_task, profile, peer_context
            )
        except AgentError:
            data = _baseline_assessment(profile)
    else:
        data = _baseline_assessment(profile)

    data = _enforce_invariants(data, profile)

    if not verdict:
        verdict = (
            f"Overall risk: {data.overall_risk_level}; "
            + ("safe to proceed" if data.safe_to_proceed else "NOT safe — clearance required")
        )
    if not reasoning:
        reasoning = (
            f"{len(data.medical_flags)} medical flag(s) identified; risk floored at "
            f"'{_condition_floor(profile)}' by the reported conditions."
        )

    summary_flags = [
        f"{f.severity}:{f.flag_id} ({f.agent_responsible})" for f in data.medical_flags
    ]

    return AgentOutput(
        agent_name=AGENT_NAME.value,
        verdict=verdict,
        confidence=_confidence_for(profile),
        reasoning=reasoning,
        flags=summary_flags,
        data=data.model_dump(),
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
        "You are the Risk Agent. Male, 34y, goal weight_loss, medical: "
        "type_2_diabetes. Review the plan for contraindications."
    )

    async def _main() -> None:
        output = await run(demo_sub_task, demo_profile)
        print(output.model_dump_json(indent=2))

    asyncio.run(_main())
