import pytest


@pytest.fixture(autouse=True)
def disable_supabase_auth_for_unit_tests(monkeypatch):
    """Keep HTTP adapter and route tests independent of live Supabase Auth."""
    import app as dashboard

    monkeypatch.setattr(dashboard, "SUPABASE_AUTH_ENABLED", False)
