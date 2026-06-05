"""Shared slowapi rate limiter.

Defined in its own module so both `main.py` (which registers the exception
handler + middleware) and `routes.py` (which decorates endpoints) can import the
same `Limiter` instance without a circular import.

`headers_enabled=True` makes slowapi attach the standard rate-limit headers
(`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) and a
`Retry-After` header on 429 responses.
"""

from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address

# Per-IP limiting. Limits are declared per-route via @limiter.limit(...).
limiter = Limiter(key_func=get_remote_address, headers_enabled=True)
