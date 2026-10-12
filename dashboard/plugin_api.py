"""open-elsewhere backend, mounted at ``/api/plugins/open-elsewhere/``.

One read-only route, ``GET /holders``: the sessions some client currently holds, taken from the
active-session registry that ``SESSION_NOT_OWNED`` ("opened by bighelp 0m ago") is built from.
The Desktop dots a sidebar row from it BEFORE the user sends into a session another client owns.

Only session id, surface name and age leave this process: no pid, lease id or metadata.
Fail-open by contract: an unreadable registry is ``{"ok": false, "holders": []}``, never an error
the Desktop would have to surface for a cosmetic hint.

The dashboard loader imports this file as a top-level module, so it stays self-contained.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Iterable

logger = logging.getLogger(__name__)

try:  # FastAPI exists in the serve/dashboard env, not in the plugin's unit-test env.
    from fastapi import APIRouter

    router = APIRouter()
except ImportError:  # pragma: no cover - unit env without FastAPI
    router = None


def shape_holders(entries: Iterable[dict[str, Any]], now: float) -> list[dict[str, Any]]:
    rows = []
    for entry in entries:
        session_id = str(entry.get("session_id") or "")
        if not session_id:
            continue
        started = entry.get("started_at")
        rows.append({
            "session_id": session_id,
            "surface": str(entry.get("surface") or "unknown"),
            "age_s": max(0.0, now - started) if isinstance(started, (int, float)) else None,
        })
    return rows


if router is not None:

    @router.get("/holders")
    def holders() -> dict[str, Any]:
        from hermes_cli.active_sessions import active_session_registry_snapshot

        try:
            entries = active_session_registry_snapshot()
        except (RuntimeError, OSError) as exc:  # ActiveSessionRegistryError is a RuntimeError
            logger.debug("open-elsewhere: registry unreadable: %s", exc)
            return {"ok": False, "holders": []}
        return {"ok": True, "holders": shape_holders(entries, time.time())}
