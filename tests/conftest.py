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


@pytest.fixture()
def conn(db_url, monkeypatch):
    """Fresh jt schema with all migrations applied, dropped again afterwards."""
    with psycopg.connect(db_url, autocommit=True) as c:
        c.execute("drop schema if exists jt cascade")
    monkeypatch.setenv("DATABASE_URL", db_url)
    from sync import migrate
    migrate.main()
    c = psycopg.connect(db_url)
    yield c
    c.close()
    with psycopg.connect(db_url, autocommit=True) as c2:
        c2.execute("drop schema if exists jt cascade")
