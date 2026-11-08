import pytest


@pytest.fixture(autouse=True)
def disable_supabase_auth_for_unit_tests(monkeypatch):
    # Existing dashboard tests exercise the standalone/local-password mode.
    # Supabase-specific tests explicitly enable the integration per test.
    import app as dashboard

    monkeypatch.setattr(dashboard, "SUPABASE_AUTH_ENABLED", False)
