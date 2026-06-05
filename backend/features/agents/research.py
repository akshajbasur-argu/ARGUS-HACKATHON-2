
"""Gemini-grounded web research — shared, live-search helper for agents.

A single Gemini ``generateContent`` call with the native ``google_search`` tool.
This issues its own request rather than going through ``base.call_claude``,
because that helper forces ``responseMimeType=application/json`` plus a
``thinkingConfig`` — and Gemini forbids structured-output/JSON mode *together*
with tools. So grounding is a separate, plain-text call whose result is injected
back into each agent's existing JSON-mode prompt.

Best-effort by design: returns ``{"summary": "", "sources": []}`` on any failure
(no key, network, bad shape) so a transient search hiccup degrades gracefully —
the agent's *answer* still comes from a real Gemini call, never hardcoded
content. The system as a whole still hard-requires GEMINI_API_KEY (enforced at
boot and at every ``call_claude``); grounding being unavailable only means an
agent reasons without fresh web context for that one run.

Returns sources as ``[{"title": str, "url": str}]`` — the shape the Trace View
renders as clickable citations.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from features.agents.base import DEFAULT_MODEL, GEMINI_URL

_MAX_SOURCES = 5
_MAX_SUMMARY_CHARS = 2000


async def gemini_grounded_research(
    query: str,
    *,
    model: str = DEFAULT_MODEL,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Run one grounded Gemini search. Returns {"summary", "sources"}.

    Never raises — any failure yields {"summary": "", "sources": []}.
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {"summary": "", "sources": []}

    payload: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": query}]}],
        "tools": [{"google_search": {}}],
        "generationConfig": {"temperature": 0.2},
    }
    headers = {"content-type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                GEMINI_URL.format(model=model),
                params={"key": api_key},
                headers=headers,
                json=payload,
            )
        if resp.status_code != 200:
            return {"summary": "", "sources": []}
        body = resp.json()
        candidate = body["candidates"][0]
        parts = candidate.get("content", {}).get("parts", []) or []
        summary = "".join(
            block.get("text", "")
            for block in parts
            if isinstance(block, dict)
        ).strip()
        sources = _extract_sources(candidate)
        return {"summary": summary[:_MAX_SUMMARY_CHARS], "sources": sources}
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        return {"summary": "", "sources": []}


def _extract_sources(candidate: dict[str, Any]) -> list[dict[str, str]]:
    """Pull deduped {title, url} citations from groundingMetadata."""
    metadata = candidate.get("groundingMetadata") or {}
    chunks = metadata.get("groundingChunks") or []
    seen: set[str] = set()
    sources: list[dict[str, str]] = []
    for chunk in chunks:
        web = (chunk or {}).get("web") or {}
        uri = web.get("uri")
        if not uri or uri in seen:
            continue
        seen.add(uri)
        sources.append({"title": str(web.get("title") or uri), "url": str(uri)})
        if len(sources) >= _MAX_SOURCES:
            break
    return sources


def grounding_block(summary: str, sources: list[dict[str, str]]) -> str:
    """Prompt fragment injecting the live research summary + source list.

    Empty string when nothing was retrieved, so a failed/empty search leaves the
    agent's prompt unchanged (it reasons without web context for that run).
    """
    if not summary and not sources:
        return ""
    lines: list[str] = []
    if summary:
        lines.append(summary)
    if sources:
        cited = "; ".join(f"{s['title']} ({s['url']})" for s in sources)
        lines.append(f"Sources: {cited}")
    return (
        "\n\nWEB RESEARCH CONTEXT (live Google Search; prefer these current "
        "facts/prices over your own memory, but do NOT copy verbatim):\n"
        + "\n".join(lines)
    )
