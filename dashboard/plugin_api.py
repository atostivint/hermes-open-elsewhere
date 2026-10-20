"""open-elsewhere backend, mounted at ``/api/plugins/open-elsewhere/``.

One read-only route, ``GET /holders``: the sessions some client currently holds, taken from the
active-session registry that ``SESSION_NOT_OWNED`` ("opened by bighelp 0m ago") is built from.
The Desktop locks a sidebar row from it BEFORE the user sends into a session another client owns.

Only session id, surface name and age leave this process: no pid, lease id or metadata.
Fail-open by contract: an unreadable registry is ``{"ok": false, "holders": []}``, never an error
the Desktop would have to surface for a cosmetic hint.

Lease ids are not row ids. The sidebar row slot carries ``sessionPinId(session)`` =
``_lineage_root_id ?? id`` (apps/desktop/src/store/session.ts:447, passed in
apps/desktop/src/app/chat/sidebar/session-row.tsx:550): the compression ROOT of the listed row.
The registry is keyed by whatever each surface leased:

- messaging gateway: the routing key ``<ns>:<platform>:<chat_type>:...`` (gateway/run_busy.py:326);
- tui_gateway (Desktop, TUI): ``session["session_key"]``, the stored row id, re-anchored to the
  continuation on compression (tui_gateway/session_compression.py:331, session_lifecycle.py:131);
- CLI: its stored ``session_id`` at claim time, never transferred on compression (cli.py:920).

So each lease id is resolved, read-only, against the profile's state.db: routing key -> the row the
gateway currently routes it to; row id -> its compression root (see ``row_id_for_lease``). Anything
that does not resolve (no state.db, missing table/column, unknown id) keeps the raw lease id.

The dashboard loader imports this file as a top-level module, so it stays self-contained.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

logger = logging.getLogger(__name__)

try:  # FastAPI exists in the serve/dashboard env, not in the plugin's unit-test env.
    from fastapi import APIRouter

    router = APIRouter()
except ImportError:  # pragma: no cover - unit env without FastAPI
    router = None

# Same defensive hop bound as SessionDB._session_lineage_root_to_tip (hermes_state_sessions.py:1543).
_MAX_HOPS = 100
# Busy wait for a locked state.db: the poll runs every 5 s, a miss only delays a lock by one poll.
_DB_TIMEOUT_S = 0.25
# Child markers that make a row its own conversation rather than a compression continuation.
_FORK_MARKERS = ("_branched_from", "_delegate_from", "_reset_from")


def _model_config(raw: Any) -> dict[str, Any]:
    # _sql_json_extract (hermes_state_common.py:84): invalid JSON reads as no markers.
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _session_row(conn: sqlite3.Connection, session_id: str) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT id, parent_session_id, end_reason, source, model_config FROM sessions WHERE id = ?",
        (session_id,),
    ).fetchone()


def _compression_parent(conn: sqlite3.Connection, child: sqlite3.Row) -> Optional[sqlite3.Row]:
    """The row *child* continues by compression, else None.

    Mirrors the continuation edge the sidebar list projects through, ``_CHAIN_STEP_SQL``
    (hermes_state_compression.py:30, used by get_compression_chain <- _project_compression_tips,
    hermes_state_sessions.py:1117): parent ended ``'compression'``; child carries no
    ``_branched_from`` / ``_delegate_from`` / ``_reset_from`` marker (presence, as in the SQL) and is
    not ``source='tool'``. The legacy same-key reset clause of ``_RESET_CHILD_SQL`` needs a parent
    ended at a reset reason, so it can never hold when the parent ended ``'compression'``.
    """
    parent_id = child["parent_session_id"]
    if not parent_id or (child["source"] or "") == "tool":
        return None
    config = _model_config(child["model_config"])
    if any(config.get(marker) is not None for marker in _FORK_MARKERS):
        return None
    parent = _session_row(conn, parent_id)
    return parent if parent is not None and parent["end_reason"] == "compression" else None


def lineage_root(conn: sqlite3.Connection, session_id: str) -> Optional[str]:
    """Compression root of a stored session (itself when it continues nothing); None if no such row."""
    row = _session_row(conn, session_id)
    if row is None:
        return None
    seen = {row["id"]}
    while len(seen) < _MAX_HOPS:
        parent = _compression_parent(conn, row)
        if parent is None or parent["id"] in seen:
            break
        seen.add(parent["id"])
        row = parent
    return row["id"]


def _routed_session_id(conn: sqlite3.Connection, session_key: str, scope: str) -> Optional[str]:
    """Stored session a gateway routing key currently points at.

    Primary: the ``gateway_routing`` index (gateway/session_persistence.py:345, "state.db
    gateway_routing is primary"), whose ``entry_json.session_id`` the gateway re-points at each
    compression continuation (gateway/run_turn_persistence.py:129). Rows are scoped by the store's
    resolved sessions dir (session_persistence.py:270); this profile's scope wins, then the newest.
    Fallback: the newest non-fork row stamped with that ``session_key`` (continuations inherit it,
    hermes_state_sessions.py:366).
    """
    try:
        for (entry_json,) in conn.execute(
            "SELECT entry_json FROM gateway_routing WHERE session_key = ?"
            " ORDER BY (scope = ?) DESC, updated_at DESC",
            (session_key, scope),
        ):
            try:
                entry = json.loads(entry_json or "{}")
            except (ValueError, TypeError, RecursionError):
                continue
            target = entry.get("session_id") if isinstance(entry, dict) else None
            if isinstance(target, str) and target:
                return target
    except sqlite3.OperationalError:  # no gateway_routing table (older schema): use the fallback
        pass
    for row in conn.execute(
        "SELECT id, source, model_config FROM sessions WHERE session_key = ?"
        " ORDER BY started_at DESC, id DESC LIMIT 20",
        (session_key,),
    ):
        config = _model_config(row["model_config"])
        if (row["source"] or "") != "tool" and config.get("_branched_from") is None and config.get("_delegate_from") is None:
            return row["id"]
    return None


def row_id_for_lease(conn: sqlite3.Connection, lease_session_id: str, scope: str = "") -> Optional[str]:
    """The id the sidebar row of this lease carries, or None when state.db does not know it."""
    root = lineage_root(conn, lease_session_id)
    if root is not None:
        return root
    stored = _routed_session_id(conn, lease_session_id, scope)
    if stored is None:
        return None
    return lineage_root(conn, stored) or stored


def resolve_row_ids(lease_ids: Iterable[str], hermes_home: Path) -> dict[str, str]:
    """``{lease id: row id}`` for the leases state.db resolves; ``{}`` on any database trouble.

    One read-only (``mode=ro``) connection per call: never creates, migrates or locks state.db.
    """
    ids = sorted({str(i) for i in lease_ids if i})
    resolved: dict[str, str] = {}
    try:
        db_path = Path(hermes_home) / "state.db"
        if not ids or not db_path.is_file():
            return {}
        scope = str((Path(hermes_home) / "sessions").resolve())
        # as_uri() percent-encodes '?'/'#' in the path (hermes_state_holders.read_only_db_uri).
        conn = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True, timeout=_DB_TIMEOUT_S)
    except Exception as exc:  # cosmetic step: raw lease ids still go out
        logger.debug("open-elsewhere: state.db unreadable: %s", exc)
        return {}
    try:
        conn.row_factory = sqlite3.Row
        for lease_id in ids:
            try:
                row_id = row_id_for_lease(conn, lease_id, scope)
            except Exception as exc:  # missing column, odd row, locked db: this lease stays raw
                logger.debug("open-elsewhere: lease %s unresolved: %s", lease_id, exc)
                continue
            if row_id:
                resolved[lease_id] = row_id
    finally:
        conn.close()
    return resolved


def shape_holders(
    entries: Iterable[dict[str, Any]], now: float, row_ids: Optional[Mapping[str, str]] = None,
) -> list[dict[str, Any]]:
    """Public rows: ``session_id`` is the row id when resolved (``row_ids``), else the raw lease id."""
    row_ids = row_ids or {}
    rows = []
    for entry in entries:
        session_id = str(entry.get("session_id") or "")
        if not session_id:
            continue
        started = entry.get("started_at")
        rows.append({
            "session_id": row_ids.get(session_id) or session_id,
            "surface": str(entry.get("surface") or "unknown"),
            "age_s": max(0.0, now - started) if isinstance(started, (int, float)) else None,
        })
    return rows


def _row_ids_for(entries: list[dict[str, Any]]) -> dict[str, str]:
    try:
        from hermes_constants import get_hermes_home  # hermes_state._default_db_path resolves the same way

        home = get_hermes_home()
    except Exception as exc:  # resolution is cosmetic: raw ids still go out
        logger.debug("open-elsewhere: no hermes home: %s", exc)
        return {}
    return resolve_row_ids((str(e.get("session_id") or "") for e in entries), home)


if router is not None:

    @router.get("/holders")
    def holders() -> dict[str, Any]:
        from hermes_cli.active_sessions import active_session_registry_snapshot

        try:
            entries = active_session_registry_snapshot()
        except (RuntimeError, OSError) as exc:  # ActiveSessionRegistryError is a RuntimeError
            logger.debug("open-elsewhere: registry unreadable: %s", exc)
            return {"ok": False, "holders": []}
        return {"ok": True, "holders": shape_holders(entries, time.time(), _row_ids_for(entries))}
