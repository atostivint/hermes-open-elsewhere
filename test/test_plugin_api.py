"""Backend half: shape of /holders, and (when a Hermes checkout is given) the real registry path.

Plain unittest, no Hermes needed for the unit tests:
    python -m unittest discover -s test -p "test_*.py"
End-to-end against the real active-session registry and a real FastAPI app, temp HERMES_HOME:
    HERMES_AGENT_SRC=<hermes-agent checkout> <hermes venv python> -m unittest discover -s test -p "test_*.py"
"""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
