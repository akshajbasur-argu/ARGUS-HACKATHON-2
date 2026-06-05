"""FastAPI application entrypoint for the Health Plan Optimizer backend.

Run locally:  uvicorn main:app --reload --port 8000

Optional services (enabled via env):
- REDIS_URL  -> durable plan/trace persistence (RedisTraceStore). When unset or
  unreachable, the app falls back to the in-memory store and still runs fully.

Rate limiting is provided by slowapi (per-IP); limits are declared per-route in
api/routes.py and 429s carry a Retry-After header.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

import redis.asyncio as aioredis  # redis-py merged aioredis in as redis.asyncio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from api.limiter import limiter
from api.routes import router as api_router
from features.trace.logger import RedisTraceStore
from features.trace.logger import logger as trace_logger

log = logging.getLogger("hpo.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Set up (and tear down) the Redis connection pool when configured."""
    redis_url = os.getenv("REDIS_URL")
    client = None
    if redis_url:
        # A pooled async client; FastAPI shares one pool across requests.
        pool = aioredis.ConnectionPool.from_url(
            redis_url, decode_responses=True, max_connections=20
        )
        client = aioredis.Redis(connection_pool=pool)
        try:
            await client.ping()
            trace_logger.set_store(RedisTraceStore(client))
            log.info("Redis store enabled at %s", redis_url)
        except Exception:  # noqa: BLE001 — degrade to in-memory, don't crash boot
            log.warning(
                "REDIS_URL set but Redis is unreachable; using in-memory store.",
                exc_info=True,
            )
            await client.aclose()
            client = None
    else:
        log.info("REDIS_URL not set; using in-memory trace store.")

    app.state.redis = client
    try:
        yield
    finally:
        if client is not None:
            await client.aclose()


app = FastAPI(
    title="Health Plan Optimizer",
    version="0.1.0",
    description="Multi-agent decision intelligence for personalised health plans.",
    lifespan=lifespan,
)

# Rate limiting (slowapi). The limiter must live on app.state for the middleware
# + exception handler to find it; the handler returns 429 + Retry-After.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# CORS — allow the Vite dev server and any configured origins.
_origins = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api")


@app.get("/healthz", tags=["health"])
async def healthz() -> dict[str, str]:
    """Liveness probe for Docker / orchestration."""
    return {"status": "ok", "service": "health-plan-optimizer"}
