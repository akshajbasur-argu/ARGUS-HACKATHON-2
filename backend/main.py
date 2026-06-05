"""FastAPI application entrypoint for the Health Plan Optimizer backend.

Run locally:  uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import router as api_router

app = FastAPI(
    title="Health Plan Optimizer",
    version="0.1.0",
    description="Multi-agent decision intelligence for personalised health plans.",
)

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
