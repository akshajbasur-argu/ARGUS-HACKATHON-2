"""Tavily web-search grounding — shared, best-effort helper for agents.

Returns an empty list when TAVILY_API_KEY is unset or the call fails, so callers
can ground their prompts when search is available and degrade silently when it
is not (the agent interface is unchanged either way).
"""

from __future__ import annotations

import os
from typing import Any

import httpx

TAVILY_URL = "https://api.tavily.com/search"


async def tavily_search(
    query: str,
    *,
    max_results: int = 2,
    timeout: float = 10.0,
) -> list[dict[str, str]]:
    """Search Tavily and return up to `max_results` {title, url, content} dicts.

    Never raises — any error (no key, network, bad shape) yields an empty list.
    """
    api_key = os.environ.get("TAVILY_API_KEY")
    if not api_key:
        return []

    payload: dict[str, Any] = {
        "api_key": api_key,
        "query": query,
        "max_results": max_results,
        "search_depth": "basic",
        "include_answer": False,
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(TAVILY_URL, json=payload)
        if resp.status_code != 200:
            return []
        results = resp.json().get("results", [])
    except (httpx.HTTPError, ValueError):
        return []

    out: list[dict[str, str]] = []
    for r in results[:max_results]:
        if not isinstance(r, dict):
            continue
        out.append(
            {
                "title": str(r.get("title", "")),
                "url": str(r.get("url", "")),
                "content": str(r.get("content", "")),
            }
        )
    return out
