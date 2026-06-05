"""Conversation store — persists chats + their plan-version DAG.

Mirrors the trace `TraceStore` pattern: a ``ConversationStore`` Protocol with an
in-memory default and a Redis-backed implementation, plus a module-level
singleton (`get_store`/`set_store`) that ``main.py`` swaps to Redis at startup
when ``REDIS_URL`` is configured.

Redis keys:
  * ``conv:{id}``   → SET the Conversation JSON
  * ``conv:index``  → ZADD id with score = updated_at epoch (sorted recency list)
"""

from __future__ import annotations

from typing import Any, Protocol

from schemas.agent_schemas import Conversation, ConversationSummary

CONV_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days
INDEX_KEY = "conv:index"
_LIST_LIMIT = 100


def conv_key(conv_id: str) -> str:
    return f"conv:{conv_id}"


def _summary(conv: Conversation) -> ConversationSummary:
    return ConversationSummary(
        id=conv.id,
        title=conv.title,
        updated_at=conv.updated_at,
        version_count=len(conv.versions),
    )


class ConversationStore(Protocol):
    async def save(self, conv: Conversation) -> None: ...
    async def get(self, conv_id: str) -> Conversation | None: ...
    async def list(self) -> list[ConversationSummary]: ...
    async def delete(self, conv_id: str) -> None: ...


class InMemoryConversationStore:
    """Process-local store (fine for single-user local dev)."""

    def __init__(self) -> None:
        self._data: dict[str, Conversation] = {}

    async def save(self, conv: Conversation) -> None:
        self._data[conv.id] = conv

    async def get(self, conv_id: str) -> Conversation | None:
        return self._data.get(conv_id)

    async def list(self) -> list[ConversationSummary]:
        items = sorted(
            self._data.values(), key=lambda c: c.updated_at, reverse=True
        )
        return [_summary(c) for c in items[:_LIST_LIMIT]]

    async def delete(self, conv_id: str) -> None:
        self._data.pop(conv_id, None)


class RedisConversationStore:
    """Durable store using the redis-py asyncio client (decode_responses=True)."""

    def __init__(self, redis: Any) -> None:
        self._redis = redis

    async def save(self, conv: Conversation) -> None:
        await self._redis.set(
            conv_key(conv.id), conv.model_dump_json(), ex=CONV_TTL_SECONDS
        )
        await self._redis.zadd(INDEX_KEY, {conv.id: conv.updated_at.timestamp()})

    async def get(self, conv_id: str) -> Conversation | None:
        raw = await self._redis.get(conv_key(conv_id))
        return Conversation.model_validate_json(raw) if raw else None

    async def list(self) -> list[ConversationSummary]:
        ids = await self._redis.zrevrange(INDEX_KEY, 0, _LIST_LIMIT - 1)
        if not ids:
            return []
        raws = await self._redis.mget([conv_key(cid) for cid in ids])
        summaries: list[ConversationSummary] = []
        stale: list[str] = []
        for cid, raw in zip(ids, raws, strict=False):
            if raw is None:
                stale.append(cid)  # expired body — drop from the index
                continue
            summaries.append(_summary(Conversation.model_validate_json(raw)))
        if stale:
            await self._redis.zrem(INDEX_KEY, *stale)
        return summaries

    async def delete(self, conv_id: str) -> None:
        await self._redis.delete(conv_key(conv_id))
        await self._redis.zrem(INDEX_KEY, conv_id)


# Module-level singleton (mirrors features/trace/logger.py::logger).
_store: ConversationStore = InMemoryConversationStore()


def get_store() -> ConversationStore:
    return _store


def set_store(store: ConversationStore) -> None:
    global _store
    _store = store
