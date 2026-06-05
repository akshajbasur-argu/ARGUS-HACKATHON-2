"""Trace Logger — records every agent I/O event and serves it over SSE.

Persistence is pluggable via the ``TraceStore`` protocol:

- ``InMemoryTraceStore`` (default): process-local dict + best-effort JSONL on
  disk. Keeps the system runnable end-to-end with zero external services.
- ``RedisTraceStore``: durable, multi-instance store using the key patterns
  required by the Infra track —
    * ``plan:{plan_id}:trace``  → ``LPUSH`` each TraceEvent as a JSON string
    * ``plan:{plan_id}:result`` → ``SET`` the FinalPlan JSON with a 7-day TTL
    * ``plan:{plan_id}:seq``    → ``INCR`` monotonic per-run sequence counter

``main.py`` selects the Redis store at startup (when ``REDIS_URL`` is set) and
swaps it in via ``logger.set_store(...)``; otherwise the in-memory default
stands. Either way, ``TraceLogger`` keeps the live SSE fan-out (in-process
asyncio queues) so connected clients get pushed events in real time, while the
store provides durable replay for late or post-run subscribers.

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
from typing import Any, Protocol

from schemas.agent_schemas import FinalPlan, TraceEvent, TraceEventType

# Terminal events — a stream closes after delivering one of these.
_TERMINAL = (TraceEventType.RUN_COMPLETED, TraceEventType.ERROR)

LOG_DIR = Path(os.getenv("TRACE_LOG_DIR", "logs"))
HEARTBEAT_SECONDS = 15.0
RESULT_TTL_SECONDS = 7 * 24 * 60 * 60  # 7 days
# Keep traces around as long as the results they describe so /api/plans replay
# stays consistent; each new event refreshes the window.
TRACE_TTL_SECONDS = RESULT_TTL_SECONDS


# -- Redis key patterns -----------------------------------------------------


def trace_key(plan_id: str) -> str:
    return f"plan:{plan_id}:trace"


def result_key(plan_id: str) -> str:
    return f"plan:{plan_id}:result"


def seq_key(plan_id: str) -> str:
    return f"plan:{plan_id}:seq"


# ---------------------------------------------------------------------------
# Persistence backends
# ---------------------------------------------------------------------------


class TraceStore(Protocol):
    """Durable storage for trace events + the final plan, keyed by plan_id."""

    async def next_seq(self, plan_id: str) -> int: ...
    async def append(self, plan_id: str, event: TraceEvent) -> None: ...
    async def get_trace(self, plan_id: str) -> list[TraceEvent]: ...
    async def save_result(self, plan_id: str, plan: FinalPlan) -> None: ...
    async def get_result(self, plan_id: str) -> FinalPlan | None: ...
    async def close(self) -> None: ...


class InMemoryTraceStore:
    """Process-local store with best-effort JSONL persistence for replay."""

    def __init__(self, log_dir: Path = LOG_DIR) -> None:
        self._trace: dict[str, list[TraceEvent]] = defaultdict(list)
        self._result: dict[str, FinalPlan] = {}
        self._seq: dict[str, int] = defaultdict(int)
        self._log_dir = log_dir

    async def next_seq(self, plan_id: str) -> int:
        self._seq[plan_id] += 1
        return self._seq[plan_id]

    async def append(self, plan_id: str, event: TraceEvent) -> None:
        self._trace[plan_id].append(event)
        self._persist(plan_id, event)

    async def get_trace(self, plan_id: str) -> list[TraceEvent]:
        return list(self._trace.get(plan_id, []))

    async def save_result(self, plan_id: str, plan: FinalPlan) -> None:
        self._result[plan_id] = plan

    async def get_result(self, plan_id: str) -> FinalPlan | None:
        return self._result.get(plan_id)

    async def close(self) -> None:  # nothing to release
        return None

    def _persist(self, plan_id: str, event: TraceEvent) -> None:
        try:
            self._log_dir.mkdir(parents=True, exist_ok=True)
            with (self._log_dir / f"{plan_id}.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(event.model_dump_json() + "\n")
        except OSError:
            # Persistence is best-effort; never let disk issues break a run.
            pass


class RedisTraceStore:
    """Redis-backed store (redis-py asyncio client, ``decode_responses=True``)."""

    def __init__(self, redis: Any) -> None:
        self._redis = redis

    async def next_seq(self, plan_id: str) -> int:
        key = seq_key(plan_id)
        seq = await self._redis.incr(key)
        await self._redis.expire(key, TRACE_TTL_SECONDS)
        return int(seq)

    async def append(self, plan_id: str, event: TraceEvent) -> None:
        key = trace_key(plan_id)
        await self._redis.lpush(key, event.model_dump_json())
        await self._redis.expire(key, TRACE_TTL_SECONDS)

    async def get_trace(self, plan_id: str) -> list[TraceEvent]:
        # LPUSH stores newest-first; LRANGE 0 -1 returns newest..oldest.
        raw = await self._redis.lrange(trace_key(plan_id), 0, -1)
        events = [TraceEvent.model_validate_json(item) for item in raw]
        events.sort(key=lambda e: e.seq)  # restore chronological order
        return events

    async def save_result(self, plan_id: str, plan: FinalPlan) -> None:
        await self._redis.set(
            result_key(plan_id), plan.model_dump_json(), ex=RESULT_TTL_SECONDS
        )

    async def get_result(self, plan_id: str) -> FinalPlan | None:
        raw = await self._redis.get(result_key(plan_id))
        return FinalPlan.model_validate_json(raw) if raw else None

    async def close(self) -> None:
        await self._redis.aclose()


# ---------------------------------------------------------------------------
# Trace logger (live fan-out + durable store)
# ---------------------------------------------------------------------------


class TraceLogger:
    """Live SSE fan-out backed by a swappable durable ``TraceStore``."""

    def __init__(self, store: TraceStore | None = None) -> None:
        self._store: TraceStore = store or InMemoryTraceStore()
        # Live subscribers, in-process. Pushed events arrive here in real time;
        # durable replay for new/late subscribers comes from the store.
        self._queues: dict[str, list[asyncio.Queue[TraceEvent]]] = defaultdict(list)
        self._done: set[str] = set()

    def set_store(self, store: TraceStore) -> None:
        self._store = store

    @property
    def store(self) -> TraceStore:
        return self._store

    # -- sequencing ---------------------------------------------------------

    async def next_seq(self, plan_id: str) -> int:
        return await self._store.next_seq(plan_id)

    # -- write path ---------------------------------------------------------

    async def log(self, plan_id: str, event: TraceEvent) -> None:
        """Persist to the store, then fan out to live SSE subscribers."""
        await self._store.append(plan_id, event)
        if event.type in _TERMINAL:
            self._done.add(plan_id)
        for q in list(self._queues.get(plan_id, [])):
            q.put_nowait(event)

    async def save_result(self, plan_id: str, plan: FinalPlan) -> None:
        await self._store.save_result(plan_id, plan)

    # -- read path ----------------------------------------------------------

    async def get_trace(self, plan_id: str) -> list[TraceEvent]:
        return await self._store.get_trace(plan_id)

    async def get_result(self, plan_id: str) -> FinalPlan | None:
        return await self._store.get_result(plan_id)

    def is_done(self, plan_id: str) -> bool:
        return plan_id in self._done

    def _unsubscribe(self, plan_id: str, q: asyncio.Queue[TraceEvent]) -> None:
        queues = self._queues.get(plan_id)
        if queues and q in queues:
            queues.remove(q)
        if not self._queues.get(plan_id):
            self._queues.pop(plan_id, None)

    # -- SSE stream ---------------------------------------------------------

    async def stream(
        self, plan_id: str, heartbeat: float = HEARTBEAT_SECONDS
    ) -> AsyncGenerator[str, None]:
        """Yield SSE frames for a plan: replay persisted history, then stream
        live, emitting a heartbeat comment every `heartbeat` seconds while idle,
        and exit after the terminal (done/error) event is delivered.

        The live queue is attached *before* reading history so no event slips
        through the gap; `seen` (keyed by seq) dedupes the overlap."""
        queue: asyncio.Queue[TraceEvent] = asyncio.Queue()
        self._queues[plan_id].append(queue)
        seen: set[int] = set()
        try:
            # 1) Replay everything already persisted.
            for event in await self._store.get_trace(plan_id):
                if event.seq in seen:
                    continue
                seen.add(event.seq)
                yield f"data: {event.model_dump_json()}\n\n"
                if event.type in _TERMINAL:
                    return  # run already finished — replay and close
            # 2) Stream live events.
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=heartbeat)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if event.seq in seen:
                    continue
                seen.add(event.seq)
                yield f"data: {event.model_dump_json()}\n\n"
                if event.type in _TERMINAL:
                    break
        finally:
            self._unsubscribe(plan_id, queue)


# Module-level singleton used by the API routes and the Coordinator.
# main.py swaps in a RedisTraceStore at startup when REDIS_URL is configured.
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
            seq=await self._logger.next_seq(self.plan_id),
            type=type,
            agent_name=agent_name,
            round=round,
            message=message,
            payload=payload or {},
            ts=time.time(),
            duration_ms=duration_ms,
        )
        await self._logger.log(self.plan_id, event)

    async def save_result(self, plan: FinalPlan) -> None:
        """Persist the synthesised plan for later GET /api/plans/{plan_id}."""
        await self._logger.save_result(self.plan_id, plan)
