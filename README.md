# Health Plan Optimizer

Multi-agent decision-intelligence system that produces a personalised health
plan. Six specialist agents (Nutrition, Macros, Fitness, Risk, Budget, Critic)
fan out from a Coordinator, debate via a peer-critique loop, and synthesise a
final recommendation. Every agent I/O streams to a live Agent Trace View.

Agents ground their reasoning in **live Google Search** via Gemini's native
grounding tool (real INR prices, current nutrition/exercise/clinical guidance),
attaching clickable sources to their output. There is **no offline fallback**:
`GEMINI_API_KEY` + internet are required, and the server fails fast at boot
without a key. (Macros stays pure Mifflin-St Jeor maths by design — only its
narration is grounded; the numbers are never fetched.)

**Stack:** React 18 · Vite · Tailwind · TypeScript · Python 3.11 · FastAPI ·
Pydantic v2 · Gemini `gemini-2.5-flash` (web-grounded) · Docker Compose.

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
cp .env.example .env        # add GEMINI_API_KEY
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
export GEMINI_API_KEY=...
docker compose up --build           # frontend :8080, backend :8000, redis :6379
```

Redis now backs durable plan/trace persistence and starts by default. Running
the backend outside Docker without `REDIS_URL` falls back to an in-memory store.

## Parallel tracks (post-scaffold)

| Track | Owns |
|---|---|
| Agents | `backend/features/agents/*`, `coordinator/`, `debate/` |
| UI | `frontend/src/features/*`, `components/` |
| Infra | Docker, `trace/` Redis backend, CI |

The contract between tracks is `backend/schemas/agent_schemas.py`
(mirrored in `frontend/src/lib/api.ts`).
