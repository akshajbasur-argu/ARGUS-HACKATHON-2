# Health Plan Optimizer

Multi-agent decision-intelligence system that produces a personalised health
plan. Six specialist agents (Nutrition, Macros, Fitness, Risk, Budget, Critic)
fan out from a Coordinator, debate via a peer-critique loop, and synthesise a
final recommendation. Every agent I/O streams to a live Agent Trace View.

**Stack:** React 18 · Vite · Tailwind · TypeScript · Python 3.11 · FastAPI ·
Pydantic v2 · Anthropic `claude-sonnet-4-6` · Docker Compose.

## Layout

```
frontend/   React + Vite + Tailwind (VibeFlow OS design system)
backend/    FastAPI + asyncio agents
docker-compose.yml
```

## Develop

### Backend
```bash
cd backend
cp .env.example .env        # add ANTHROPIC_API_KEY
poetry install
poetry run uvicorn main:app --reload --port 8000
# health check: http://localhost:8000/healthz
```

### Frontend
```bash
cd frontend
cp .env.example .env
npm install
npm run dev                 # http://localhost:5173 (proxies /api -> :8000)
```

## Run with Docker
```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build           # frontend :8080, backend :8000
docker compose --profile cache up   # also starts redis
```

## Parallel tracks (post-scaffold)

| Track | Owns |
|---|---|
| Agents | `backend/features/agents/*`, `coordinator/`, `debate/` |
| UI | `frontend/src/features/*`, `components/` |
| Infra | Docker, `trace/` Redis backend, CI |

The contract between tracks is `backend/schemas/agent_schemas.py`
(mirrored in `frontend/src/lib/api.ts`).
