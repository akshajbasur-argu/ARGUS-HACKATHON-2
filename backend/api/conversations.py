"""Conversation + versioning routes (chat / re-plan / history).

  POST   /api/conversations               -> create an empty conversation
  GET    /api/conversations               -> list summaries (sidebar)
  GET    /api/conversations/{id}          -> full conversation (messages + DAG)
  DELETE /api/conversations/{id}          -> remove a conversation
  POST   /api/conversations/{id}/messages -> the main chat turn

The chat turn runs the Intake agent, merges the profile, and on `ready`/`replan`
spawns a new plan version: it generates a plan_id, appends a PlanVersion node
(branching from the currently-viewed version), and kicks the existing
Coordinator pipeline off as a background task so the client can open the live SSE
trace for that plan_id (reusing GET /api/stream/{plan_id} and /api/plans/{id}).
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from features.agents import intake_agent
from features.conversations.store import get_store
from features.coordinator import coordinator
from features.trace.logger import logger as trace_logger
from schemas.agent_schemas import (
    ChatMessage,
    ChatMessageRequest,
    ChatRole,
    ChatTurnResponse,
    ChatTurnStatus,
    Conversation,
    ConversationSummary,
    PlanVersion,
    UserProfile,
)

log = logging.getLogger("hpo.conversations")

router = APIRouter()

# Keep references to background pipeline tasks so they aren't garbage-collected.
_BG_TASKS: set[asyncio.Task] = set()

_FIELD_LABELS = {
    "age": "age",
    "weight_kg": "weight (kg)",
    "height_cm": "height (cm)",
    "sex": "sex",
    "activity_level": "activity level",
    "primary_goal": "main goal",
    "weekly_budget_inr": "weekly budget (INR)",
}


def _humanise(fields: list[str]) -> str:
    labels = [_FIELD_LABELS.get(f, f) for f in fields]
    if len(labels) <= 1:
        return labels[0] if labels else "a few details"
    return ", ".join(labels[:-1]) + " and " + labels[-1]


def _derive_title(profile: dict) -> str:
    goal = profile.get("primary_goal")
    if isinstance(goal, str) and goal:
        return goal.replace("_", " ").title() + " plan"
    return "Health plan"


def _build_profile(profile: dict) -> UserProfile | None:
    try:
        return UserProfile.model_validate(profile)
    except ValidationError:
        return None


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)


async def _run_pipeline(
    profile: UserProfile, plan_id: str, directives: str | None
) -> None:
    """Run the full Coordinator pipeline in the background (trace streams live)."""
    try:
        await coordinator.run(profile, run_id=plan_id, directives=directives)
    except Exception:  # noqa: BLE001 — already traced as ERROR; just log here
        log.exception("Background pipeline failed for plan %s", plan_id)


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.post("/conversations", response_model=Conversation, tags=["conversations"])
async def create_conversation() -> Conversation:
    conv = Conversation(id=uuid.uuid4().hex)
    await get_store().save(conv)
    return conv


@router.get(
    "/conversations",
    response_model=list[ConversationSummary],
    tags=["conversations"],
)
async def list_conversations() -> list[ConversationSummary]:
    return await get_store().list()


@router.get(
    "/conversations/{conv_id}", response_model=Conversation, tags=["conversations"]
)
async def get_conversation(conv_id: str) -> Conversation:
    conv = await get_store().get(conv_id)
    if conv is None:
        raise HTTPException(status_code=404, detail=f"No conversation {conv_id}")
    return conv


@router.delete("/conversations/{conv_id}", tags=["conversations"])
async def delete_conversation(conv_id: str) -> dict[str, str]:
    await get_store().delete(conv_id)
    return {"status": "deleted", "id": conv_id}


# ---------------------------------------------------------------------------
# The main chat turn
# ---------------------------------------------------------------------------


@router.post(
    "/conversations/{conv_id}/messages",
    response_model=ChatTurnResponse,
    tags=["conversations"],
)
async def post_message(conv_id: str, body: ChatMessageRequest) -> ChatTurnResponse:
    store = get_store()
    conv = await store.get(conv_id)
    if conv is None:
        raise HTTPException(status_code=404, detail=f"No conversation {conv_id}")

    conv.messages.append(ChatMessage(role=ChatRole.USER, content=body.content))

    has_plan = len(conv.versions) > 0
    latest_plan = (
        await trace_logger.get_result(conv.versions[-1].plan_id) if has_plan else None
    )

    try:
        result = await intake_agent.run(
            conv.messages, conv.profile, latest_plan=latest_plan, has_plan=has_plan
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("Intake agent failed")
        raise HTTPException(status_code=502, detail="Intake agent failed") from exc

    # Merge the patch (ignore null clears).
    for k, v in result.profile_patch.items():
        if v is not None:
            conv.profile[k] = v

    status = result.status
    assistant_message = result.assistant_message
    new_version: PlanVersion | None = None

    if status in (ChatTurnStatus.READY, ChatTurnStatus.REPLAN):
        profile_model = _build_profile(conv.profile)
        missing = intake_agent.missing_required(conv.profile)
        if profile_model is None or missing:
            # The model jumped ahead — fall back to collecting the gaps.
            status = ChatTurnStatus.COLLECTING
            if missing:
                assistant_message = (
                    f"Almost there — I still need your {_humanise(missing)}. "
                    "Could you share that?"
                )
        else:
            plan_id = uuid.uuid4().hex
            parent = body.parent_version_id or (
                conv.versions[-1].version_id if conv.versions else None
            )
            directives = (
                result.plan_change if status == ChatTurnStatus.REPLAN else None
            )
            new_version = PlanVersion(
                version_id=uuid.uuid4().hex,
                plan_id=plan_id,
                parent_version_id=parent,
                label=f"v{len(conv.versions) + 1}",
                change_request=directives,
            )
            conv.versions.append(new_version)
            if conv.title == "New chat":
                conv.title = _derive_title(conv.profile)
            _spawn(_run_pipeline(profile_model, plan_id, directives))

    conv.messages.append(
        ChatMessage(role=ChatRole.ASSISTANT, content=assistant_message)
    )
    conv.updated_at = datetime.now(timezone.utc)
    await store.save(conv)

    return ChatTurnResponse(
        assistant_message=assistant_message,
        status=status,
        profile=conv.profile,
        version=new_version,
        conversation=conv,
    )
