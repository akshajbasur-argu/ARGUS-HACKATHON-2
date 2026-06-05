"""HTTP + SSE routes.

  POST /api/run               -> runs the full multi-agent pipeline, returns FinalPlan
  GET  /api/stream/{plan_id}  -> Server-Sent Events stream of TraceEvent frames

Live trace pattern: the client generates a run_id, opens the SSE stream first,
then POSTs /api/run with that run_id. The TraceLogger replay buffer also makes
the stream work if it connects after the run has already started or finished.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from features.coordinator import coordinator
from features.trace.logger import logger as trace_logger
from schemas.agent_schemas import FinalPlan, RunRequest

logger = logging.getLogger("hpo.api")

router = APIRouter()

# Headers that keep SSE flowing through proxies (disable buffering/caching).
_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",  # nginx: don't buffer the stream
}


@router.post("/run", response_model=FinalPlan, tags=["run"])
async def run(request: RunRequest) -> FinalPlan:
    """Run the full pipeline (decompose -> agents -> debate -> synthesise)."""
    try:
        return await coordinator.run(
            request.profile,
            max_debate_rounds=request.max_debate_rounds,
            run_id=request.run_id,
        )
    except Exception as exc:  # noqa: BLE001 — convert any failure to a 500
        logger.exception("Pipeline run failed")
        raise HTTPException(status_code=500, detail="Pipeline run failed") from exc


@router.get("/stream/{plan_id}", tags=["trace"])
async def stream(plan_id: str) -> StreamingResponse:
    """SSE stream of trace events for a run. Replays history, then streams live
    (with a heartbeat), and closes after the run's terminal event."""
    return StreamingResponse(
        trace_logger.stream(plan_id),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )
