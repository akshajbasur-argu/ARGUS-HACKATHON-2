"""Shared plumbing for all specialist agents.

Every agent makes its Gemini call through `call_claude` (raw httpx, no SDK)
and parses the model's reply with `extract_json`, so the five specialists share
one transport, one error surface, and one JSON-recovery strategy.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

from schemas.agent_schemas import AgentOutput

# Load backend/.env when running locally so every agent sees GEMINI_API_KEY
# without requiring the shell or uvicorn to inject it explicitly.
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

# Canonical model id. Mirrors features/coordinator/prompts.py::MODEL.
DEFAULT_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class AgentError(Exception):
    """Base class for agent failures."""


class AgentAPIError(AgentError):
    """The Gemini call failed (auth, network, non-200, bad shape)."""


class AgentParseError(AgentError):
    """The model reply could not be parsed/validated into the expected JSON."""


async def call_claude(
    system: str,
    user: str,
    *,
    model: str = DEFAULT_MODEL,
    max_tokens: int = 2048,
    temperature: float = 0.4,
    prefill: str | None = None,
    response_schema: dict[str, Any] | None = None,
    timeout: float = 60.0,
) -> str:
    """Single async Gemini GenerateContent call. Returns the text reply.

    The `prefill` parameter is retained for compatibility with the older
    legacy prefill path; Gemini JSON mode returns structured output directly, so the
    helper ignores it.
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise AgentAPIError("GEMINI_API_KEY is not set")

    generation_config: dict[str, Any] = {
        "temperature": temperature,
        "maxOutputTokens": max_tokens,
        "responseMimeType": "application/json",
        "thinkingConfig": {
            "thinkingBudget": 0
        },
    }
    if response_schema is not None:
        generation_config["responseJsonSchema"] = response_schema

    payload: dict[str, Any] = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": generation_config,
    }
    headers = {"content-type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                GEMINI_URL.format(model=model),
                params={"key": api_key},
                headers=headers,
                json=payload,
            )
    except httpx.HTTPError as exc:
        raise AgentAPIError(f"Gemini request failed: {exc}") from exc

    if resp.status_code != 200:
        raise AgentAPIError(
            f"Gemini API returned {resp.status_code}: {resp.text[:500]}"
        )

    body = resp.json()
    try:
        candidates = body["candidates"]
        parts = candidates[0]["content"]["parts"]
        text = "".join(
            block.get("text", "")
            for block in parts
            if isinstance(block, dict)
        )
    except (KeyError, TypeError, IndexError) as exc:
        raise AgentAPIError(f"Unexpected Gemini response shape: {exc}") from exc

    return text


@dataclass
class SessionContext:
    """Per-run agent memory, keyed by plan_id.

    Stores each round's specialist outputs and the Critic's review, so an agent
    re-run during the debate loop can reference its own prior output and the
    critique that rejected it. Complements `peer_context` (other agents' current
    outputs); this is the temporal/historical memory for one plan_id.
    """

    plan_id: str
    _outputs: dict[int, dict[str, AgentOutput]] = field(default_factory=dict)
    _critiques: dict[int, dict[str, Any]] = field(default_factory=dict)

    def record_outputs(
        self, round: int, outputs: dict[str, AgentOutput] | list[AgentOutput]
    ) -> None:
        by_name = (
            outputs
            if isinstance(outputs, dict)
            else {o.agent_name: o for o in outputs}
        )
        self._outputs[round] = dict(by_name)

    def record_critique(self, round: int, critic_output: AgentOutput) -> None:
        self._critiques[round] = dict(critic_output.data)

    def prior_output(self, agent_name: str) -> AgentOutput | None:
        for rnd in sorted(self._outputs, reverse=True):
            out = self._outputs[rnd].get(agent_name)
            if out is not None:
                return out
        return None

    def latest_critique(self) -> dict[str, Any] | None:
        if not self._critiques:
            return None
        return self._critiques[max(self._critiques)]

    def revision_block(self, agent_name: str) -> str:
        """Prompt fragment summarising prior output + critique for this agent.

        Empty string when there's nothing agent-specific to recall (e.g. round 1,
        or an agent the Critic never flagged).
        """
        prior = self.prior_output(agent_name)
        crit = self.latest_critique()

        body: list[str] = []
        if prior is not None:
            body.append(
                f"- Your previous verdict: {prior.verdict!r} "
                f"(confidence {prior.confidence})."
            )
        if crit is not None:
            rev = crit.get("revision_requests", {}).get(agent_name)
            if rev:
                body.append(f"- Critic's revision request for you: {rev}")
            for c in crit.get("contradictions", []):
                if agent_name in c.get("agents_involved", []):
                    body.append(
                        f"- Contradiction: {c.get('field_a')}={c.get('value_a')} vs "
                        f"{c.get('field_b')}={c.get('value_b')} → {c.get('resolution')}"
                    )

        if not body:
            return ""
        return (
            "\n\nPRIOR ROUND MEMORY (revise to resolve, keep the rest consistent):\n"
            + "\n".join(body)
        )


def extract_json(text: str) -> dict[str, Any]:
    """Parse a JSON object from a model reply, tolerating fences/stray prose.

    Raises AgentParseError if no valid JSON object can be recovered.
    """
    s = text.strip()

    # Strip ```json ... ``` fences if present.
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*", "", s)
        s = re.sub(r"\s*```$", "", s.strip())

    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    # Fallback: slice the outermost { ... }.
    start, end = s.find("{"), s.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(s[start : end + 1])
        except json.JSONDecodeError as exc:
            raise AgentParseError(f"Could not parse JSON object: {exc}") from exc

    raise AgentParseError("No JSON object found in model reply")
