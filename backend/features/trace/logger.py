"""Trace Logger — records every agent I/O event and serves it over SSE.

TraceLogger keeps an in-memory history per plan_id, persists each event to
logs/{plan_id}.jsonl for post-run replay/debugging, and exposes an async
`stream()` generator that yields SSE-formatted frames with a 15s heartbeat and
exits once the run's terminal event is logged.

Field/terminal mapping vs the 1.D.1 spec:
- TraceEvent uses `type`/`ts` (+ duration_ms), not `event_type`/`timestamp` —
  this is the contract the frontend + tests already use.
- The "done" terminal is `run_completed` (or `error`).
- SSE frames are data-only ("data: {json}\\n\\n") so the browser's
  EventSource.onmessage fires; heartbeats are SSE comments (": keep-alive").
"""

from __future__ import annotations

import asyncio
import os
import time
from collections import defaultdict
from collections.abc import AsyncGenerator
from pathlib import Path

from schemas.agent_schemas import TraceEvent, TraceEventType

# Terminal events — a stream closes after delivering one of these.
_TERMINAL = (TraceEventType.RUN_COMPLETED, TraceEventType.ERROR)

LOG_DIR = Path(os.getenv("TRACE_LOG_DIR", "logs"))
HEARTBEAT_SECONDS = 15.0


class TraceLogger:
    """In-memory + JSONL trace store with live SSE fan-out, keyed by plan_id."""

    def __init__(self, log_dir: Path = LOG_DIR) -> None:
        self._history: dict[str, list[TraceEvent]] = defaultdict(list)
        self._queues: dict[str, list[asyncio.Queue[TraceEvent]]] = defaultdict(list)
        self._seq: dict[str, int] = defaultdict(int)
        self._done: set[str] = set()
        self._log_dir = log_dir

    # -- sequencing ---------------------------------------------------------

    def next_seq(self, plan_id: str) -> int:
        self._seq[plan_id] += 1
        return self._seq[plan_id]

    # -- write path ---------------------------------------------------------

    def log(self, plan_id: str, event: TraceEvent) -> None:
        """Append to history, persist to JSONL, and fan out to live streams."""
        self._history[plan_id].append(event)
        self._persist(plan_id, event)
        if event.type in _TERMINAL:
            self._done.add(plan_id)
        for q in list(self._queues.get(plan_id, [])):
            q.put_nowait(event)

    def _persist(self, plan_id: str, event: TraceEvent) -> None:
        try:
            self._log_dir.mkdir(parents=True, exist_ok=True)
            with (self._log_dir / f"{plan_id}.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(event.model_dump_json() + "\n")
        except OSError:
            # Persistence is best-effort; never let disk issues break a run.
            pass

    # -- read path ----------------------------------------------------------

    def get_trace(self, plan_id: str) -> list[TraceEvent]:
        return list(self._history.get(plan_id, []))

    def is_done(self, plan_id: str) -> bool:
        return plan_id in self._done

    def _subscribe(self, plan_id: str) -> asyncio.Queue[TraceEvent]:
        q: asyncio.Queue[TraceEvent] = asyncio.Queue()
        for event in self._history.get(plan_id, []):  # replay history first
            q.put_nowait(event)
        self._queues[plan_id].append(q)
        return q

    def _unsubscribe(self, plan_id: str, q: asyncio.Queue[TraceEvent]) -> None:
        queues = self._queues.get(plan_id)
        if queues and q in queues:
            queues.remove(q)

    def _cleanup(self, plan_id: str) -> None:
        if not self._queues.get(plan_id):
            self._history.pop(plan_id, None)
            self._seq.pop(plan_id, None)
            self._done.discard(plan_id)
            self._queues.pop(plan_id, None)

    # -- SSE stream ---------------------------------------------------------

    async def stream(
        self, plan_id: str, heartbeat: float = HEARTBEAT_SECONDS
    ) -> AsyncGenerator[str, None]:
        """Yield SSE frames for a plan. Replays history, then streams live,
        emitting a heartbeat comment every `heartbeat` seconds while idle, and
        exits after the terminal (done/error) event is delivered."""
        queue = self._subscribe(plan_id)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=heartbeat)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                yield f"data: {event.model_dump_json()}\n\n"
                if event.type in _TERMINAL:
                    break
        finally:
            self._unsubscribe(plan_id, queue)
            self._cleanup(plan_id)


# Module-level singleton used by the API stream route and the Coordinator.
logger = TraceLogger()


class Tracer:
    """Convenience emitter bound to a plan_id; assigns seq + timestamp."""

    def __init__(self, plan_id: str, _logger: TraceLogger = logger) -> None:
        self.plan_id = plan_id
        self._logger = _logger

    async def emit(
        self,
        type: TraceEventType,
        *,
        agent_name: str | None = None,
        round: int | None = None,
        message: str = "",
        payload: dict | None = None,
        duration_ms: float | None = None,
    ) -> None:
        event = TraceEvent(
            run_id=self.plan_id,
            seq=self._logger.next_seq(self.plan_id),
            type=type,
            agent_name=agent_name,
            round=round,
            message=message,
            payload=payload or {},
            ts=time.time(),
            duration_ms=duration_ms,
        )
        self._logger.log(self.plan_id, event)
