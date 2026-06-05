"""Peer-critique debate loop.

Runs the Critic over the specialist outputs for up to MAX_ROUNDS. Each round,
any agent the Critic rejects is re-run with its revision_request appended to its
original sub-task and the other agents' outputs supplied as peer_context. The
loop is bounded by MAX_ROUNDS and by the fact that re-runnable rejections must
exist, so it always terminates.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from features.agents import (
    budget_agent,
    critic_agent,
    fitness_agent,
    macros_agent,
    nutrition_agent,
    risk_agent,
)
from features.agents.base import SessionContext
from schemas.agent_schemas import AgentOutput, UserProfile

MAX_ROUNDS = 3

# agent_name -> its run(sub_task, profile, *, peer_context, round) coroutine fn
AgentRunner = Callable[..., Awaitable[AgentOutput]]
AGENT_RUNNERS: dict[str, AgentRunner] = {
    "nutrition": nutrition_agent.run,
    "macros": macros_agent.run,
    "fitness": fitness_agent.run,
    "risk": risk_agent.run,
    "budget": budget_agent.run,
}


@dataclass
class DebateResult:
    final_outputs: list[AgentOutput]
    critic: AgentOutput
    rounds: int


async def run_debate(
    outputs: list[AgentOutput],
    profile: UserProfile,
    sub_tasks: dict[str, str],
    max_rounds: int = MAX_ROUNDS,
    tracer: "object | None" = None,
    session_context: SessionContext | None = None,
) -> DebateResult:
    """Iteratively critique and revise until clean or max_rounds reached.

    Args:
        outputs: initial specialist AgentOutputs (one per agent).
        profile: the user profile (passed to re-runs).
        sub_tasks: agent_name -> original Coordinator sub_task, needed to re-run
            a rejected agent with its revision appended.
        tracer: optional Tracer; if given, emits DEBATE_ROUND events.
        session_context: per-run memory; records each round's outputs + critique
            so re-run agents can reference their prior output and the critique.
    """
    from schemas.agent_schemas import TraceEventType

    session = session_context or SessionContext(plan_id="debate")
    current: dict[str, AgentOutput] = {o.agent_name: o for o in outputs}
    session.record_outputs(1, current)
    rounds = 0
    critic_out: AgentOutput | None = None

    while True:
        rounds += 1
        if tracer is not None:
            await tracer.emit(
                TraceEventType.AGENT_STARTED, agent_name="critic", round=rounds
            )
        critic_out = await critic_agent.review(current, profile, round=rounds)
        session.record_critique(rounds, critic_out)

        rejected: list[str] = critic_out.data["rejected_agents"]
        if tracer is not None:
            await tracer.emit(
                TraceEventType.DEBATE_ROUND,
                agent_name="critic",
                round=rounds,
                message=critic_out.verdict,
                payload={
                    "rejected_agents": rejected,
                    "approved_agents": critic_out.data.get("approved_agents", []),
                    "revision_requests": critic_out.data.get("revision_requests", {}),
                    "contradictions": critic_out.data.get("contradictions", []),
                    "consistency_score": critic_out.data["consistency_score"],
                    "critique_summary": critic_out.data.get("critique_summary", ""),
                },
            )
        if not rejected or rounds >= max_rounds:
            break

        revisions: dict[str, str] = critic_out.data["revision_requests"]

        async def _run_timed(
            runner: AgentRunner, sub_task: str, *, peer_context: dict, round: int
        ) -> tuple[AgentOutput, float]:
            t0 = time.perf_counter()
            out = await runner(
                sub_task,
                profile,
                peer_context=peer_context,
                round=round,
                session_context=session,
            )
            return out, (time.perf_counter() - t0) * 1000.0

        # Build re-run coroutines for every rejected agent we can actually re-run.
        names: list[str] = []
        inputs: dict[str, str] = {}
        peers_of: dict[str, list[str]] = {}
        coros: list[Awaitable[tuple[AgentOutput, float]]] = []
        for name in rejected:
            runner = AGENT_RUNNERS.get(name)
            sub_task = sub_tasks.get(name)
            if runner is None or sub_task is None:
                continue
            revised_sub_task = (
                f"{sub_task}\n\nREVISION REQUEST (round {rounds + 1}): "
                f"{revisions.get(name, 'Revise to resolve the flagged contradiction.')}"
            )
            peer_context = {n: current[n].data for n in current if n != name}
            names.append(name)
            inputs[name] = revised_sub_task
            peers_of[name] = [n for n in current if n != name]
            coros.append(
                _run_timed(
                    runner, revised_sub_task, peer_context=peer_context, round=rounds + 1
                )
            )

        if not coros:
            # Nothing re-runnable (e.g. missing sub_tasks) — avoid spinning.
            break

        # Re-run start events (round n+1) so the graph re-animates revised nodes.
        if tracer is not None:
            for name in names:
                await tracer.emit(
                    TraceEventType.AGENT_STARTED,
                    agent_name=name,
                    round=rounds + 1,
                    message=f"Revising (round {rounds + 1})",
                    payload={
                        "input": inputs[name],
                        "peer_context_agents": peers_of[name],
                        "round": rounds + 1,
                    },
                )

        results = await asyncio.gather(*coros, return_exceptions=True)
        for name, result in zip(names, results):
            # On a failed re-run, keep the agent's previous output.
            if isinstance(result, tuple):
                out, duration_ms = result
                current[name] = out
                if tracer is not None:
                    await tracer.emit(
                        TraceEventType.AGENT_COMPLETED,
                        agent_name=name,
                        round=rounds + 1,
                        message=out.verdict,
                        payload={
                            "verdict": out.verdict,
                            "reasoning": out.reasoning,
                            "output": out.data,
                            "sources": out.data.get("sources", []),
                            "confidence": out.confidence,
                            "flags": out.flags,
                            "revised": True,
                        },
                        duration_ms=duration_ms,
                    )
        session.record_outputs(rounds + 1, current)

    assert critic_out is not None  # loop runs at least once
    return DebateResult(
        final_outputs=list(current.values()),
        critic=critic_out,
        rounds=rounds,
    )
