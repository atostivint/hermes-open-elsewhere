"""Backend half: shape of /holders, and (when a Hermes checkout is given) the real registry path.

Plain unittest, no Hermes needed for the unit tests:
    python -m unittest discover -s test -p "test_*.py"
End-to-end against the real active-session registry and a real FastAPI app, temp HERMES_HOME:
    HERMES_AGENT_SRC=<hermes-agent checkout> <hermes venv python> -m unittest discover -s test -p "test_*.py"
"""

import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SRC = os.environ.get("HERMES_AGENT_SRC")


def load_plugin_api():
    # Same way the dashboard loads it: a standalone module from its file path.
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_open_elsewhere", ROOT / "dashboard/plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ShapeHolders(unittest.TestCase):
    def test_only_session_surface_and_age_leave_the_process(self):
        api = load_plugin_api()
        rows = api.shape_holders(
            [{"session_id": "s1", "surface": "bighelp", "started_at": 90.0, "pid": 4242, "lease_id": "x", "metadata": {"k": 1}}],
            now=100.0,
        )

        self.assertEqual(rows, [{"session_id": "s1", "surface": "bighelp", "age_s": 10.0}])

    def test_rows_without_a_session_id_are_dropped_and_odd_fields_degrade(self):
        api = load_plugin_api()
        rows = api.shape_holders([{"surface": "tui"}, {"session_id": "s2", "started_at": "bad"}], now=1.0)

        self.assertEqual(rows, [{"session_id": "s2", "surface": "unknown", "age_s": None}])

    def test_resolved_lease_ids_are_replaced_by_the_row_id_and_the_rest_stay_raw(self):
        api = load_plugin_api()
        rows = api.shape_holders(
            [{"session_id": "agent:main:telegram:dm:42", "surface": "gateway:telegram"}, {"session_id": "s9", "surface": "cli"}],
            now=1.0,
            row_ids={"agent:main:telegram:dm:42": "tg-root"},
        )

        self.assertEqual([(r["session_id"], r["surface"]) for r in rows], [("tg-root", "gateway:telegram"), ("s9", "cli")])


# The columns the mapping reads, with Hermes's names (hermes_state_common.py SCHEMA).
MINIMAL_SCHEMA = """
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model_config TEXT, parent_session_id TEXT,
                       started_at REAL, end_reason TEXT, session_key TEXT);
CREATE TABLE gateway_routing (scope TEXT NOT NULL DEFAULT '', session_key TEXT NOT NULL,
                              entry_json TEXT NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY (scope, session_key));
"""


def session(conn, sid, *, parent=None, end=None, source="cli", config=None, key=None, at=0.0):
    conn.execute(
        "INSERT INTO sessions (id, source, model_config, parent_session_id, started_at, end_reason, session_key)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, source, json.dumps(config) if config is not None else None, parent, at, end, key),
    )


class ResolveRowIds(unittest.TestCase):
    def setUp(self):
        self.api = load_plugin_api()
        self.home = Path(self.enterContext(tempfile.TemporaryDirectory(ignore_cleanup_errors=True)))
        self.conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(self.conn.close)
        self.conn.executescript(MINIMAL_SCHEMA)

    def resolve(self, *ids):
        self.conn.commit()
        return self.api.resolve_row_ids(ids, self.home)

    def test_every_segment_of_a_compression_chain_resolves_to_its_root(self):
        session(self.conn, "root", end="compression", at=1)
        session(self.conn, "mid", parent="root", end="compression", at=2)
        session(self.conn, "tip", parent="mid", at=3)
        session(self.conn, "plain", at=4)

        self.assertEqual(self.resolve("root", "mid", "tip", "plain"), {"root": "root", "mid": "root", "tip": "root", "plain": "plain"})

    def test_branch_delegate_reset_tool_and_non_compression_children_are_their_own_rows(self):
        session(self.conn, "p", end="compression", at=1)
        session(self.conn, "branch", parent="p", config={"_branched_from": "p"}, at=2)
        session(self.conn, "sub", parent="p", config={"_delegate_from": "p"}, at=2)
        session(self.conn, "reset", parent="p", config={"_reset_from": "p"}, at=2)
        session(self.conn, "tool", parent="p", source="tool", at=2)
        session(self.conn, "q", end="branched", at=1)
        session(self.conn, "after-branch", parent="q", at=2)

        self.assertEqual(
            self.resolve("branch", "sub", "reset", "tool", "after-branch"),
            {"branch": "branch", "sub": "sub", "reset": "reset", "tool": "tool", "after-branch": "after-branch"},
        )

    def test_a_branch_continuation_carrying_the_inherited_marker_stays_its_own_row_as_in_the_sidebar(self):
        # Compression copies model_config, so the continuation of a /branch child still names the
        # branch's parent; _CHAIN_STEP_SQL tests presence, so the sidebar lists it on its own.
        session(self.conn, "origin", at=0)
        session(self.conn, "br", parent="origin", config={"_branched_from": "origin"}, end="compression", at=1)
        session(self.conn, "br-tip", parent="br", config={"_branched_from": "origin"}, at=2)
        session(self.conn, "bad-json", parent="br", at=3)
        self.conn.execute("UPDATE sessions SET model_config = '{oops' WHERE id = 'bad-json'")

        self.assertEqual(self.resolve("br-tip", "bad-json"), {"br-tip": "br-tip", "bad-json": "br"})

    def test_a_gateway_routing_key_resolves_through_gateway_routing_to_the_root(self):
        key = "agent:main:telegram:dm:42"
        session(self.conn, "tg-root", source="telegram", key=key, end="compression", at=1)
        session(self.conn, "tg-tip", parent="tg-root", source="telegram", key=key, at=2)
        session(self.conn, "tg-other", source="telegram", key=key, at=3)
        scope = str((self.home / "sessions").resolve())
        self.conn.execute("INSERT INTO gateway_routing VALUES (?, ?, ?, ?)", (scope, key, json.dumps({"session_id": "tg-tip"}), 1.0))
        self.conn.execute("INSERT INTO gateway_routing VALUES (?, ?, ?, ?)", ("/elsewhere", key, json.dumps({"session_id": "tg-other"}), 9.0))

        self.assertEqual(self.resolve(key), {key: "tg-root"})

    def test_without_a_routing_entry_the_newest_non_fork_row_with_that_key_is_used(self):
        key = "agent:main:discord:group:7"
        session(self.conn, "d-old", source="discord", key=key, at=1)
        session(self.conn, "d-root", source="discord", key=key, end="compression", at=2)
        session(self.conn, "d-tip", parent="d-root", source="discord", key=key, at=3)
        session(self.conn, "d-sub", parent="d-tip", source="discord", key=key, config={"_delegate_from": "d-tip"}, at=4)
        self.conn.execute("DROP TABLE gateway_routing")

        self.assertEqual(self.resolve(key), {key: "d-root"})

    def test_unknown_ids_and_a_compression_cycle_do_not_hang_or_invent_ids(self):
        session(self.conn, "a", parent="b", end="compression", at=1)
        session(self.conn, "b", parent="a", end="compression", at=2)

        resolved = self.resolve("a", "nope")
        self.assertNotIn("nope", resolved)
        self.assertIn(resolved["a"], {"a", "b"})

    def test_fail_open_on_missing_db_missing_columns_and_garbage(self):
        self.assertEqual(self.api.resolve_row_ids(["x"], self.home / "absent"), {})

        self.conn.executescript("DROP TABLE sessions; CREATE TABLE sessions (id TEXT PRIMARY KEY);")
        self.conn.execute("INSERT INTO sessions VALUES ('x')")
        self.assertEqual(self.resolve("x"), {})

        garbage = self.home / "garbage"
        garbage.mkdir()
        (garbage / "state.db").write_bytes(b"not a database" * 100)
        self.assertEqual(self.api.resolve_row_ids(["x"], garbage), {})

    def test_the_database_is_opened_read_only(self):
        session(self.conn, "s", at=1)
        self.conn.commit()
        with mock.patch.object(self.api, "row_id_for_lease", side_effect=lambda conn, *a: conn.execute("DELETE FROM sessions")):
            self.assertEqual(self.api.resolve_row_ids(["s"], self.home), {})
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 1)


@unittest.skipUnless(SRC, "set HERMES_AGENT_SRC to run against the real registry")
class RealRegistry(unittest.TestCase):
    def test_a_lease_held_by_another_client_is_served_by_the_route(self):
        with tempfile.TemporaryDirectory() as home:
            os.environ["HERMES_HOME"] = home
            sys.path.insert(0, SRC)
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
            from hermes_cli.active_sessions import release_active_session, try_acquire_active_session

            lease, refusal = try_acquire_active_session(session_id="sess-1", surface="bighelp", config={})
            self.assertIsNone(refusal)
            try:
                app = FastAPI()
                app.include_router(load_plugin_api().router, prefix="/api/plugins/open-elsewhere")
                body = TestClient(app).get("/api/plugins/open-elsewhere/holders").json()
            finally:
                release_active_session(lease)

            self.assertTrue(body["ok"])
            self.assertEqual([(h["session_id"], h["surface"]) for h in body["holders"]], [("sess-1", "bighelp")])

    def test_gateway_and_compressed_leases_come_back_as_the_ids_the_sidebar_rows_carry(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as home:
            os.environ["HERMES_HOME"] = home
            sys.path.insert(0, SRC)
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
            from hermes_cli.active_sessions import release_active_session, try_acquire_active_session
            from hermes_state import SessionDB

            key = "agent:main:telegram:dm:42"
            db = SessionDB(db_path=Path(home) / "state.db")  # the real schema
            try:
                # A messaging conversation that compressed once; the gateway routes its key to the tip.
                db.create_session("tg-root", source="telegram", session_key=key, chat_id="42", chat_type="dm")
                db.end_session("tg-root", "compression")
                db.create_session("tg-tip", source="telegram", session_key=key, parent_session_id="tg-root")
                db.save_gateway_routing_entry(
                    key, json.dumps({"session_key": key, "session_id": "tg-tip"}),
                    scope=str((Path(home) / "sessions").resolve()),
                )
                # A terminal conversation compressed twice; tui_gateway re-anchors its lease on the tip.
                db.create_session("cli-root", source="cli")
                db.end_session("cli-root", "compression")
                db.create_session("cli-mid", source="cli", parent_session_id="cli-root")
                db.end_session("cli-mid", "compression")
                db.create_session("cli-tip", source="cli", parent_session_id="cli-mid")
                # A /branch child is its own row even though its parent compressed.
                db.create_session("cli-branch", source="cli", parent_session_id="cli-mid", model_config={"_branched_from": "cli-mid"})
                sidebar_ids = {row.get("_lineage_root_id") or row["id"] for row in db.list_sessions_rich(limit=50)}
            finally:
                db.close()

            leases = []
            try:
                for lease_key, surface in ((key, "gateway:telegram"), ("cli-tip", "tui"), ("cli-branch", "cli"), ("sess-x", "bighelp")):
                    lease, refusal = try_acquire_active_session(session_id=lease_key, surface=surface, config={})
                    self.assertIsNone(refusal)
                    leases.append(lease)
                app = FastAPI()
                app.include_router(load_plugin_api().router, prefix="/api/plugins/open-elsewhere")
                body = TestClient(app).get("/api/plugins/open-elsewhere/holders").json()
            finally:
                for lease in leases:
                    release_active_session(lease)

            self.assertTrue(body["ok"])
            held = {(h["session_id"], h["surface"]) for h in body["holders"]}
            self.assertEqual(held, {("tg-root", "gateway:telegram"), ("cli-root", "tui"), ("cli-branch", "cli"), ("sess-x", "bighelp")})
            # The mapped ids are exactly what Hermes's own list hands the Desktop (sessionPinId).
            self.assertLessEqual({"tg-root", "cli-root", "cli-branch"}, sidebar_ids)
            self.assertTrue(all(set(h) == {"session_id", "surface", "age_s"} for h in body["holders"]))


if __name__ == "__main__":
    unittest.main()
