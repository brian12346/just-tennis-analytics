import os
import pathlib
import sys

import psycopg
import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


@pytest.fixture(scope="session")
def db_url():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("set TEST_DATABASE_URL to a throwaway Postgres database to run database tests")
    return url


# Supabase-only schemas the migrations touch (pg_cron, pg_net, Vault, Storage), stood in for by tests/supabase_stubs.sql
STUB_SCHEMAS = ("cron", "net", "vault", "storage", "extensions")
STUBS = (ROOT / "tests" / "supabase_stubs.sql").read_text()


def _reset(c):
    c.execute("drop schema if exists jt cascade")
    for s in STUB_SCHEMAS:
        c.execute(f"drop schema if exists {s} cascade")


@pytest.fixture()
def conn(db_url, monkeypatch):
    """Fresh jt schema with all migrations applied, dropped again afterwards."""
    with psycopg.connect(db_url, autocommit=True) as c:
        _reset(c)
        c.execute(STUBS)
    monkeypatch.setenv("DATABASE_URL", db_url)
    from sync import migrate
    migrate.main()
    c = psycopg.connect(db_url)
    yield c
    c.close()
    with psycopg.connect(db_url, autocommit=True) as c2:
        _reset(c2)
