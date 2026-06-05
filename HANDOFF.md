# HealthFlow — Implementation Handoff / Context

> Snapshot for moving to a new machine. Branch: **`dev`** (work is **uncommitted** — see
> [§9 Moving laptops](#9-moving-to-a-new-laptop)). Source plan:
> `~/.claude/plans/harmonic-meandering-engelbart.md`.

## 1. The plan being followed

Turn the working multi-agent health-planner into a **conversational, versioned,
web-grounded** system, in build order **5 → 1 → 2/3/4** (grounding first so every
later demo shows live sources; trace graph second as a graded deliverable;
chat/versioning/history last).

| Phase | What | Status |
|---|---|---|
| **5** | Web grounding via Gemini Google-Search; drop all offline fallbacks; fail-fast without key | ✅ **Done + verified** |
| **1** | Agent Trace View as an interactive React Flow graph + clickable Step Detail drawer; Execution Log as 2nd tab; enriched trace payloads | ✅ **Done + verified** |
| **2–4 backend** | Conversation entity, intake/concierge agent, plan-version DAG, conversation store, `/api/conversations` router | ✅ **Done + verified** |
| **2–4 frontend** | Chat UI, sidebar history, version-graph switcher, workspace tabs, quick-fill modal | 🟡 **~90% — `App.tsx` rewrite + verification remain (build is currently RED)** |

⚠️ **Build-blocking:** `frontend/src/App.tsx` still calls the **old** `AppShell`
API (`onboarding/trace/results`). `AppShell.tsx` was just rewritten to
`sidebar/chat/workspace/modal`. **`npm run lint` (tsc) will fail until App.tsx is
replaced** — the ready-to-paste version is in [§7](#7-the-one-remaining-file-apptsx).

---

## 2. Phase 5 — Web grounding (DONE)

- **New** `backend/features/agents/research.py` — `gemini_grounded_research(query)
  -> {summary, sources:[{title,url}]}` (own httpx call with `tools=[{google_search:{}}]`,
  no JSON mode — Gemini forbids tools + structured output together) + shared
  `grounding_block(summary, sources)` prompt helper. Best-effort (empty on failure).
- Wired grounding into **nutrition, budget (live INR prices), fitness, risk, macros**
  (macros narration only — the maths stays pure Mifflin–St Jeor). Each attaches
  `data["sources"] = [{title,url}]` (was `list[str]` in nutrition; frontend read none, safe).
- **Dropped fallbacks / fail-fast:**
  - `coordinator.py`: removed `_fallback_subtasks`, `_fallback_narrative`, all
    `if not GEMINI_API_KEY` branches; `decompose`/`_llm_narrative` now raise on bad output.
  - `risk_agent.py`: **fully fail-fast** (locked decision) — removed `_baseline_assessment`
    + no-key/except branches; **kept** the deterministic `_enforce_invariants` risk floor.
  - `macros_agent.py`: removed no-key branch; **kept** `_deterministic_narrative` only as
    transient-failure resilience (it restates computed numbers, not fetched knowledge).
  - `critic_agent.py`: removed no-key branch; **kept** the `except → deterministic` summary
    (the Critic is awaited directly in the debate loop, so a raise would abort the whole run).
  - `main.py` lifespan: **boot guard** raises if `GEMINI_API_KEY` missing.
  - Deleted `backend/features/agents/search.py` (Tavily). Updated `.env.example` + `README.md`.
- **Locked decisions (asked the user):** Risk = *fully fail-fast*; Macros = *ground the narration*.
- **Verified:** live run returned real sources (bigbasket/tradeindia…); no-key → `AgentAPIError`
  (no offline output); full pipeline ran with a real debate round.

## 3. Phase 1 — Trace graph (DONE)

- **Backend payload enrichment** (no schema change — `TraceEvent.payload` is free-form):
  - `coordinator.py`: decompose `AGENT_COMPLETED` → `{sub_tasks}`; `AGENT_STARTED` →
    `{input, peer_context_agents, round}`; specialist `AGENT_COMPLETED` →
    `{verdict, reasoning, output, sources, confidence, flags}`; `SYNTHESIS` → `{inputs_from}`.
  - `critique_loop.py`: `DEBATE_ROUND` → `{rejected_agents, approved_agents,
    revision_requests, contradictions, consistency_score, critique_summary}`; emits
    Critic `AGENT_STARTED` + per-rerun `AGENT_STARTED`/`AGENT_COMPLETED` (with `revised:true`).
- **Frontend** (added `@xyflow/react`):
  - `deriveTrace.ts` — shared reducer folding SSE events → rich per-node state.
  - `AgentTraceGraph.tsx` — React Flow canvas, custom glass nodes (Coordinator → 5
    specialists → Critic → Synthesis), influence edges (sub-task / reviewed / revision (rN) /
    feeds plan / QA gate), live idle→thinking→complete/flagged animation, `onNodeClick`.
  - `StepDetailDrawer.tsx` — slide-in drawer: input, output (pretty JSON), reasoning,
    sources (clickable), confidence/flags/timing; Coordinator=sub-tasks, Critic=rounds/
    contradictions, Synthesis=inputs.
  - `AgentTraceView.tsx` — refactored into the **Execution Log** tab (props-driven, rows clickable).
  - `AgentTracePanel.tsx` — owns SSE + tabs (Graph | Execution Log) + drawer.
  - `api.ts` — added `duration_ms`, `TraceSource`, `Contradiction`, payload typings.
- **Verified:** tsc + `vite build` green; live HTTP run streamed 20 enriched SSE frames
  including a real debate round (nutrition rejected r1 → `revised` r2 → revision edge).

## 4. Phase 2–4 backend — Chat / versioning / history (DONE)

- **`schemas/agent_schemas.py`:** `ChatRole`, `ChatTurnStatus`
  (collecting|ready|answer|replan), `ChatMessage`, `PlanVersion{version_id, plan_id,
  parent_version_id, label, change_request, created_at}`, `Conversation{id, title,
  messages[], profile(partial dict), versions[]}`, `ConversationSummary`,
  `ChatMessageRequest{content, parent_version_id}`, `ChatTurnResponse`.
- **`features/agents/intake_agent.py`:** Gemini concierge. Collects the 10 profile fields,
  returns strict JSON `{assistant_message, profile_patch, status, plan_change?}`; helper
  `missing_required(profile)`. Hard-requires the key (no fallback).
- **`features/conversations/store.py`:** `ConversationStore` Protocol + `InMemory` + `Redis`
  impls (keys `conv:{id}` + `conv:index` zset) + module singleton `get_store()/set_store()`
  (mirrors `trace/logger.py`).
- **`api/conversations.py`:** `POST/GET /conversations`, `GET/DELETE /conversations/{id}`,
  `POST /conversations/{id}/messages` (the main turn). On `ready`/`replan` it generates a
  `plan_id`, appends a `PlanVersion` branching from `body.parent_version_id` (or the last
  version), and **spawns `coordinator.run(profile, run_id=plan_id, directives=plan_change)`
  as an `asyncio` background task** so the client opens the live SSE trace. A `ready`/`replan`
  with an incomplete profile is coerced back to `collecting`.
- **`coordinator.py`:** `decompose`/`run` gained an optional `directives` arg (the replan
  change request, woven into the decompose prompt → whole pipeline honours it).
- **`main.py`:** sets `RedisConversationStore` alongside the trace store; mounts the router.
- **Verified (live, in-memory store):** create → 1 message with full profile → **ready**, v1
  (ROOT), title auto-set, background run streamed 22 SSE frames to `run_completed`; "make it
  cheaper" → **replan**, v2 (`parent = v1`, `change_request` set); v1 = ₹2482/wk, v2 = **₹1088/wk**
  (directive worked); list shows 1 convo / 2 versions.

## 5. Phase 2–4 frontend — DONE so far

All new/edited and **type-clean individually**, but see the build-blocker (App.tsx):

- `lib/api.ts` — conversation types + client fns (`createConversation`, `listConversations`,
  `getConversation`, `deleteConversation`, `postChatMessage`, `getPlan`, `PlanRecord`).
- `lib/usePlan.ts` — polls `GET /api/plans/{id}` until the result lands (`idle|pending|completed`).
- `features/chat/ChatPanel.tsx` — message stream + input + status hint + Quick-fill button.
- `features/conversations/ConversationSidebar.tsx` — list + New chat + delete + relative time.
- `features/versions/VersionGraph.tsx` — compact React Flow DAG (depth layout, parent→child
  edges, click to select).
- `features/workspace/WorkspacePanel.tsx` — VersionGraph switcher + tabs (Trace = AgentTracePanel,
  Plan = ResultsPanel / generating state).
- `features/onboarding/OnboardingForm.tsx` — added optional `onQuickFill(message)`; submit
  assembles a sentence instead of POSTing `/run`.
- `features/onboarding/QuickFillModal.tsx` — overlay wrapping OnboardingForm.
- `components/layout/AppShell.tsx` — **rewritten** to `sidebar | chat | workspace (+modal)`,
  3-zone grid on `lg`, bottom-tab zone switch below `lg`.

---

## 6. What's LEFT (in order)

1. **Rewrite `frontend/src/App.tsx`** to drive the new shell — paste [§7](#7-the-one-remaining-file-apptsx). *(build-blocking)*
2. `cd frontend && npm run lint` (tsc) → fix any small type nits → `npm run build`.
3. **Live click-through verify** (plan's acceptance test): new chat → answer the concierge →
   plan generates (watch the live graph) → "make it cheaper" → **v2 branches off v1** in the
   version graph → switch versions swaps plan + trace → **reload → sidebar persists** (needs
   Redis for cross-process; in-memory only persists within one server process — see §8).
4. **Polish (optional):** the `answer` status path (questions about an existing plan) is wired
   end-to-end but unexercised in the UI; verify a "what's my protein target?" turn renders.
5. **Commit & push** (§9).

---

## 7. The one remaining file: `App.tsx`

Replace `frontend/src/App.tsx` with this (compiles against the new AppShell + all components above):

```tsx
import { useEffect, useState } from "react";
import AppShell, { type AgentStatus } from "./components/layout/AppShell";
import ConversationSidebar from "./features/conversations/ConversationSidebar";
import ChatPanel from "./features/chat/ChatPanel";
import WorkspacePanel from "./features/workspace/WorkspacePanel";
import QuickFillModal from "./features/onboarding/QuickFillModal";
import { usePlan } from "./lib/usePlan";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  postChatMessage,
  type ChatMessage,
  type ChatTurnStatus,
  type Conversation,
  type ConversationSummary,
} from "./lib/api";

const ACTIVE_KEY = "hpo:activeConversationId";

export default function App() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_KEY),
  );
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [lastStatus, setLastStatus] = useState<ChatTurnStatus | null>(null);
  const [quickFillOpen, setQuickFillOpen] = useState(false);

  const refreshList = () =>
    listConversations().then(setConversations).catch(() => {});

  useEffect(() => {
    refreshList();
  }, []);

  // Load the active conversation whenever the id changes.
  useEffect(() => {
    if (!conversationId) {
      setConversation(null);
      setSelectedVersionId(null);
      localStorage.removeItem(ACTIVE_KEY);
      return;
    }
    localStorage.setItem(ACTIVE_KEY, conversationId);
    let active = true;
    getConversation(conversationId)
      .then((c) => {
        if (!active) return;
        setConversation(c);
        setSelectedVersionId(c.versions[c.versions.length - 1]?.version_id ?? null);
      })
      .catch(() => {
        if (active) setConversationId(null); // stale id
      });
    return () => {
      active = false;
    };
  }, [conversationId]);

  const selectedVersion =
    conversation?.versions.find((v) => v.version_id === selectedVersionId) ?? null;
  const activePlanId = selectedVersion?.plan_id ?? null;
  const { plan, status: planStatus } = usePlan(activePlanId);

  const newChat = async () => {
    const c = await createConversation();
    setConversation(c);
    setConversationId(c.id);
    setSelectedVersionId(null);
    setLastStatus(null);
    refreshList();
  };

  const selectConversation = (id: string) => {
    if (id !== conversationId) {
      setLastStatus(null);
      setConversationId(id);
    }
  };

  const removeConversation = async (id: string) => {
    await deleteConversation(id);
    if (id === conversationId) setConversationId(null);
    refreshList();
  };

  const sendMessage = async (content: string) => {
    setSending(true);
    try {
      let conv = conversation;
      if (!conv) {
        conv = await createConversation();
        setConversation(conv);
        setConversationId(conv.id);
      }
      const optimistic: ChatMessage = {
        role: "user",
        content,
        created_at: new Date().toISOString(),
      };
      setConversation((c) =>
        c ? { ...c, messages: [...c.messages, optimistic] } : c,
      );
      const resp = await postChatMessage(conv.id, content, selectedVersionId);
      setConversation(resp.conversation);
      setLastStatus(resp.status);
      if (resp.version) setSelectedVersionId(resp.version.version_id);
      refreshList();
    } catch {
      const err: ChatMessage = {
        role: "assistant",
        content: "⚠ Something went wrong. Please try again.",
        created_at: new Date().toISOString(),
      };
      setConversation((c) => (c ? { ...c, messages: [...c.messages, err] } : c));
    } finally {
      setSending(false);
    }
  };

  const status: AgentStatus = sending
    ? "running"
    : activePlanId && planStatus === "pending"
      ? "running"
      : plan
        ? "done"
        : "ready";

  return (
    <AppShell
      status={status}
      sidebar={
        <ConversationSidebar
          conversations={conversations}
          activeId={conversationId}
          onSelect={selectConversation}
          onNew={newChat}
          onDelete={removeConversation}
        />
      }
      chat={
        <ChatPanel
          conversation={conversation}
          sending={sending}
          lastStatus={lastStatus}
          onSend={sendMessage}
          onQuickFill={() => setQuickFillOpen(true)}
        />
      }
      workspace={
        <WorkspacePanel
          planId={activePlanId}
          versions={conversation?.versions ?? []}
          selectedVersionId={selectedVersionId}
          onSelectVersion={setSelectedVersionId}
          plan={plan}
          planStatus={planStatus}
        />
      }
      modal={
        quickFillOpen ? (
          <QuickFillModal
            onClose={() => setQuickFillOpen(false)}
            onSubmit={sendMessage}
          />
        ) : null
      }
    />
  );
}
```

After pasting: `cd frontend && npm run lint && npm run build`. (`ResultsPanel.tsx`,
`OnboardingForm.tsx`, `SkeletonCard.tsx` are unchanged and reused.)

---

## 8. How to run & verify

Environments do **not** travel between laptops — recreate them:

```bash
# Backend (Python 3.13, poetry)
cd backend
cp .env.example .env          # then set GEMINI_API_KEY=...   (REQUIRED, see §9)
poetry install
poetry run uvicorn main:app --reload --port 8000

# Frontend
cd frontend
npm install                   # restores @xyflow/react etc. from package-lock.json
npm run dev                   # http://localhost:5173 (proxies /api -> :8000)
```

- Poetry venv used during this session:
  `~/.cache/pypoetry/virtualenvs/health-plan-optimizer-backend-TaIkxx8Y-py3.13/bin/python`
  (will differ on the new machine — use `poetry run`).
- Backend checks: `poetry run python -m py_compile <files>`, `poetry run ruff check .`
  (note: pre-existing E501/B905/UP017 nits exist repo-wide; new code matches repo style).
- Frontend checks: `npm run lint` (tsc), `npm run build`.
- **Redis** (optional, for history that survives a server restart): `docker compose up`
  starts redis on :6379 and sets `REDIS_URL`. Without it the store is in-memory (history
  persists within one running server process but not across restarts).

## 9. Moving to a new laptop

1. **Commit & push** — all work is uncommitted on branch `dev`:
   ```bash
   git add -A && git commit -m "Phases 5,1,2-4 (backend) + 2-4 frontend WIP (App.tsx pending)"
   git push origin dev
   ```
   (Includes this `HANDOFF.md`.) Then `git pull` on the new machine.
2. **`backend/.env` does NOT travel** (gitignored) — recreate it and re-add `GEMINI_API_KEY`.
   The app fails fast at boot without it (intended).
3. `node_modules/` and the poetry venv don't travel — run `npm install` / `poetry install`.
4. First thing on the new machine: do [§7](#7-the-one-remaining-file-apptsx), then §6 steps 2–4.

## 10. Locked decisions / gotchas

- Risk agent = **fully fail-fast** (no offline baseline) but keeps its deterministic risk floor.
- Macros = **grounded narration**, maths stays pure formula; deterministic narration kept only
  as transient-failure resilience.
- Critic keeps a deterministic summary fallback (whole-run blast radius if it raises).
- `sources` standardized to `[{title,url}]` everywhere (Gemini returns Vertex redirect URLs;
  the `title` carries the real domain — that's expected).
- Re-plan is a **full pipeline re-run** into a new version node; the change request rides through
  `coordinator.run(..., directives=...)`.
- New-version runs are **background tasks** → the client opens SSE `/api/stream/{plan_id}` and
  polls `/api/plans/{plan_id}` (via `usePlan`) for the final plan.
- Trace contract unchanged on the wire (`type`/`ts`); `TraceEvent.payload` is free-form `dict`.
- If short on time, Phases **5 + 1 alone** already satisfy the graded trace deliverable with live sources.
```
