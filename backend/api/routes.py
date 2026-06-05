"""HTTP + SSE routes.

  POST /api/run               -> runs the full multi-agent pipeline, returns FinalPlan
  GET  /api/stream/{plan_id}  -> Server-Sent Events stream of TraceEvent frames
  GET  /api/plans/{plan_id}   -> persisted FinalPlan + trace (from Redis/store)

Live trace pattern: the client generates a run_id, opens the SSE stream first,
then POSTs /api/run with that run_id. The TraceLogger replay buffer also makes
the stream work if it connects after the run has already started or finished.

Rate limiting (slowapi, per-IP):
  POST /api/run    -> 5/minute
  GET  /api/stream -> 20/minute
Endpoints take an explicit `request: Request` so slowapi can read the client IP.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.limiter import limiter
from features.coordinator import coordinator
from features.trace.logger import logger as trace_logger
from schemas.agent_schemas import FinalPlan, RunRequest, TraceEvent

logger = logging.getLogger("hpo.api")

router = APIRouter()

# Headers that keep SSE flowing through proxies (disable buffering/caching).
_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",  # nginx: don't buffer the stream
}


class PlanRecord(BaseModel):
    """Persisted view of a run: the final plan (if ready) plus its full trace."""

    plan_id: str
    status: str  # "completed" once the FinalPlan is stored, else "pending"
    result: FinalPlan | None = None
    trace: list[TraceEvent] = []


@router.post("/run", response_model=FinalPlan, tags=["run"])
@limiter.limit("5/minute")
async def run(request: Request, payload: RunRequest) -> FinalPlan:
    """Run the full pipeline (decompose -> agents -> debate -> synthesise)."""
    try:
        return await coordinator.run(
            payload.profile,
            max_debate_rounds=payload.max_debate_rounds,
            run_id=payload.run_id,
        )
    except Exception as exc:  # noqa: BLE001 — convert any failure to a 500
        logger.exception("Pipeline run failed")
        raise HTTPException(status_code=500, detail="Pipeline run failed") from exc


@router.get("/stream/{plan_id}", tags=["trace"])
@limiter.limit("20/minute")
async def stream(request: Request, plan_id: str) -> StreamingResponse:
    """SSE stream of trace events for a run. Replays history, then streams live
    (with a heartbeat), and closes after the run's terminal event."""
    return StreamingResponse(
        trace_logger.stream(plan_id),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.get("/plans/{plan_id}", response_model=PlanRecord, tags=["run"])
async def get_plan(plan_id: str) -> PlanRecord:
    """Fetch a persisted plan + its trace from the store (Redis when enabled).

    404 only when nothing is known about the plan_id (no result and no trace)."""
    result = await trace_logger.get_result(plan_id)
    trace = await trace_logger.get_trace(plan_id)
    if result is None and not trace:
        raise HTTPException(status_code=404, detail=f"No plan found for {plan_id}")
    return PlanRecord(
        plan_id=plan_id,
        status="completed" if result is not None else "pending",
        result=result,
        trace=trace,
    )
